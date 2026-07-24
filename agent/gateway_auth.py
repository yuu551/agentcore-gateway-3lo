"""Gatewayの3LO認可（URL elicitation）をハンドリングするstrandsフック。

未認可のツール呼び出しに対してGatewayが返す認可要求エラーを検出し、
認可URLをフロントエンドへ通知したうえで、認可が完了するまで
同じツール呼び出しをリトライする。リトライの実行自体はstrandsの
フック機構（AfterToolCallEvent.retry)に任せる。
"""
import asyncio
import json
import logging
import time

from strands.hooks import AfterToolCallEvent, HookProvider, HookRegistry

logger = logging.getLogger("gateway_auth")

AUTH_POLL_INTERVAL = 5  # 秒
AUTH_DEADLINE_SECONDS = 300  # 5分

# strandsのMCPClientが-32042（elicitation）エラーを変換した際のマーカー
ELICITATION_MARKER = "MCP Elicitation required"

TOOL_PREFIX_TO_PROVIDER = {
    "githubmcp___": "github",
    "slackmcp___": "slack",
    "googlecal___": "google_calendar",
}


def provider_from_tool_name(tool_name: str) -> str | None:
    """Gateway tool name から provider ID を解決する。"""
    for prefix, provider in TOOL_PREFIX_TO_PROVIDER.items():
        if tool_name.startswith(prefix):
            return provider
    return None


def extract_auth_url(result) -> str | None:
    """エラー結果からelicitationの認可URLを取り出す。認可要求でなければNone。"""
    if not result:
        return None
    status = result.get("status") if hasattr(result, "get") else None
    if status != "error":
        return None
    content = result.get("content", []) if hasattr(result, "get") else []
    for block in content:
        text = block.get("text", "") if isinstance(block, dict) else ""
        if ELICITATION_MARKER not in text:
            continue
        _, _, data = text.partition("with data ")
        try:
            for elicitation in json.loads(data):
                if elicitation.get("url"):
                    return elicitation["url"]
        except json.JSONDecodeError:
            logger.warning("elicitationデータの解析に失敗")
            return None
    return None


# 後方互換エイリアス
_extract_auth_url = extract_auth_url


class GatewayAuthHook(HookProvider):
    """未認可エラーを検出して認可URLを通知し、認可完了までリトライさせる。"""

    def __init__(self, event_queue: asyncio.Queue):
        self._event_queue = event_queue
        self._notified_providers: set[str] = set()
        self._deadlines: dict[str, float] = {}

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterToolCallEvent, self._on_after_tool_call)

    async def _on_after_tool_call(self, event: AfterToolCallEvent) -> None:
        tool_name = event.tool_use.get("name", "") if event.tool_use else ""
        provider = provider_from_tool_name(tool_name)
        auth_url = extract_auth_url(event.result)

        if auth_url is None:
            if (
                provider
                and provider in self._notified_providers
                and _result_status(event.result) == "success"
            ):
                await self._event_queue.put({
                    "type": "connection_status",
                    "provider": provider,
                    "status": "connected",
                })
                self._deadlines.pop(provider, None)
            return

        # provider が特定できない場合も認可自体は進める
        key = provider or f"unknown:{tool_name}"

        if key not in self._deadlines:
            self._deadlines[key] = time.monotonic() + AUTH_DEADLINE_SECONDS
        if time.monotonic() > self._deadlines[key]:
            logger.error("認可タイムアウト: tool=%s provider=%s", tool_name, provider)
            error_event = {
                "type": "error",
                "scope": "chat",
                "code": "authorization_timeout",
                "data": "認可の待機時間を超えました。もう一度お試しください。",
            }
            if provider:
                error_event["provider"] = provider
            await self._event_queue.put(error_event)
            self._deadlines.pop(key, None)
            return  # リトライをやめてエラー結果をモデルに返す

        if key not in self._notified_providers:
            payload = {
                "type": "auth_required",
                "auth_url": auth_url,
            }
            if provider:
                payload["provider"] = provider
            await self._event_queue.put(payload)
            self._notified_providers.add(key)
            logger.info("auth_required notified provider=%s", provider or "unknown")

        await asyncio.sleep(AUTH_POLL_INTERVAL)
        event.retry = True  # 結果を破棄して同じツールを再実行する


def _result_status(result) -> str | None:
    if not result:
        return None
    if hasattr(result, "get"):
        return result.get("status")
    return getattr(result, "status", None)
