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


class GatewayAuthHook(HookProvider):
    """未認可エラーを検出して認可URLを通知し、認可完了までリトライさせる。"""

    def __init__(self, event_queue: asyncio.Queue):
        self._event_queue = event_queue
        self._notified = False
        self._deadline: float | None = None

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(AfterToolCallEvent, self._on_after_tool_call)

    async def _on_after_tool_call(self, event: AfterToolCallEvent) -> None:
        auth_url = _extract_auth_url(event.result)
        if auth_url is None:
            return  # 認可要求ではない結果はそのまま通す

        if self._deadline is None:
            self._deadline = time.monotonic() + AUTH_DEADLINE_SECONDS
        if time.monotonic() > self._deadline:
            logger.error("認可タイムアウト: %s", event.tool_use.get("name"))
            return  # リトライをやめてエラー結果をモデルに返す

        if not self._notified:
            await self._event_queue.put({
                "type": "auth_required",
                "auth_url": auth_url,
            })
            self._notified = True

        await asyncio.sleep(AUTH_POLL_INTERVAL)
        event.retry = True  # 結果を破棄して同じツールを再実行する


def _extract_auth_url(result) -> str | None:
    """エラー結果からelicitationの認可URLを取り出す。認可要求でなければNone。"""
    if result.get("status") != "error":
        return None
    for block in result.get("content", []):
        text = block.get("text", "")
        if ELICITATION_MARKER not in text:
            continue
        _, _, data = text.partition("with data ")
        try:
            for elicitation in json.loads(data):
                if elicitation.get("url"):
                    return elicitation["url"]
        except json.JSONDecodeError:
            logger.warning("elicitationデータの解析に失敗: %s", text)
            return None
    return None
