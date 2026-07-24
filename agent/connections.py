"""接続確認用の Gateway ツール呼び出し。

- connection_check: 認可を待たず 1 回だけ確認する
- connection_probe: 未連携時は認可 URL を返し、完了まで再試行する

LLM / Strands Agent / Memory を使わず、読み取り専用ツールを直接呼ぶ。
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from gateway_auth import (
    AUTH_DEADLINE_SECONDS,
    AUTH_POLL_INTERVAL,
    extract_auth_url,
)

logger = logging.getLogger("connections")

ProviderId = str

PROVIDER_PROBES: dict[str, tuple[str, dict[str, Any]]] = {
    "github": ("githubmcp___get_me", {}),
    "slack": (
        "slackmcp___slack_search_channels",
        {"query": "general", "limit": 1, "response_format": "concise"},
    ),
    "google_calendar": ("googlecal___listCalendars", {"maxResults": 1}),
}

ERROR_MESSAGES = {
    "invalid_provider": "このサービスは利用できません。",
    "authorization_timeout": "認可の待機時間を超えました。もう一度お試しください。",
    "provider_unavailable": "サービスへ接続できませんでした。時間をおいて再試行してください。",
    "probe_tool_missing": "接続確認用のツールが構成されていません。",
}

SleepFn = Callable[[float], Awaitable[None]]


def resolve_probe(provider: str) -> tuple[str, dict[str, Any]] | None:
    return PROVIDER_PROBES.get(provider)


async def run_connection_probe(
    *,
    gateway: Any,
    provider: str,
    sleep: SleepFn | None = None,
    poll_interval: float = AUTH_POLL_INTERVAL,
    deadline_seconds: float = AUTH_DEADLINE_SECONDS,
):
    """接続プローブを実行し、SSE イベントを yield する。

    tool の結果本文はフロントへ返さない。
    """
    sleep_fn = sleep or asyncio.sleep
    probe = resolve_probe(provider)
    if probe is None:
        yield {
            "type": "error",
            "scope": "connection",
            "code": "invalid_provider",
            "data": ERROR_MESSAGES["invalid_provider"],
        }
        return

    tool_name, arguments = probe
    started = time.monotonic()
    logger.info("connection_probe start provider=%s", provider)

    try:
        tools = gateway.list_tools_sync()
        available = {getattr(t, "tool_name", None) for t in tools}
        if tool_name not in available:
            logger.error(
                "connection_probe probe_tool_missing provider=%s", provider
            )
            yield {
                "type": "error",
                "scope": "connection",
                "provider": provider,
                "code": "probe_tool_missing",
                "data": ERROR_MESSAGES["probe_tool_missing"],
            }
            return

        yield {
            "type": "connection_status",
            "provider": provider,
            "status": "checking",
        }

        deadline = time.monotonic() + deadline_seconds
        notified = False

        while True:
            result = await gateway.call_tool_async(
                tool_use_id=str(uuid.uuid4()),
                name=tool_name,
                arguments=arguments,
            )
            result_dict = _as_dict(result)
            auth_url = extract_auth_url(result_dict)

            if auth_url is not None:
                if not notified:
                    yield {
                        "type": "auth_required",
                        "provider": provider,
                        "auth_url": auth_url,
                    }
                    notified = True
                    logger.info(
                        "connection_probe auth_required provider=%s", provider
                    )

                if time.monotonic() > deadline:
                    logger.error(
                        "connection_probe authorization_timeout provider=%s",
                        provider,
                    )
                    yield {
                        "type": "error",
                        "scope": "connection",
                        "provider": provider,
                        "code": "authorization_timeout",
                        "data": ERROR_MESSAGES["authorization_timeout"],
                    }
                    return

                await sleep_fn(poll_interval)
                continue

            if result_dict.get("status") == "success":
                elapsed_ms = int((time.monotonic() - started) * 1000)
                logger.info(
                    "connection_probe connected provider=%s elapsed_ms=%s",
                    provider,
                    elapsed_ms,
                )
                yield {
                    "type": "connection_status",
                    "provider": provider,
                    "status": "connected",
                }
                return

            logger.error(
                "connection_probe provider_unavailable provider=%s", provider
            )
            yield {
                "type": "error",
                "scope": "connection",
                "provider": provider,
                "code": "provider_unavailable",
                "data": ERROR_MESSAGES["provider_unavailable"],
            }
            return
    except Exception:
        logger.exception("connection_probe unexpected error provider=%s", provider)
        yield {
            "type": "error",
            "scope": "connection",
            "provider": provider,
            "code": "provider_unavailable",
            "data": ERROR_MESSAGES["provider_unavailable"],
        }


async def run_connection_check(
    *,
    gateway: Any,
    provider: str,
):
    """認可を待たない接続確認。tool を 1 回だけ呼び、elicitation は not_connected にする。"""
    probe = resolve_probe(provider)
    if probe is None:
        yield {
            "type": "error",
            "scope": "connection",
            "code": "invalid_provider",
            "data": ERROR_MESSAGES["invalid_provider"],
        }
        return

    tool_name, arguments = probe
    started = time.monotonic()
    logger.info("connection_check start provider=%s", provider)

    try:
        tools = gateway.list_tools_sync()
        available = {getattr(t, "tool_name", None) for t in tools}
        if tool_name not in available:
            logger.error(
                "connection_check probe_tool_missing provider=%s", provider
            )
            yield {
                "type": "error",
                "scope": "connection",
                "provider": provider,
                "code": "probe_tool_missing",
                "data": ERROR_MESSAGES["probe_tool_missing"],
            }
            return

        yield {
            "type": "connection_status",
            "provider": provider,
            "status": "checking",
        }

        result = await gateway.call_tool_async(
            tool_use_id=str(uuid.uuid4()),
            name=tool_name,
            arguments=arguments,
        )
        result_dict = _as_dict(result)
        auth_url = extract_auth_url(result_dict)

        if auth_url is not None:
            logger.info("connection_check not_connected provider=%s", provider)
            yield {
                "type": "connection_status",
                "provider": provider,
                "status": "not_connected",
            }
            return

        if result_dict.get("status") == "success":
            elapsed_ms = int((time.monotonic() - started) * 1000)
            logger.info(
                "connection_check connected provider=%s elapsed_ms=%s",
                provider,
                elapsed_ms,
            )
            yield {
                "type": "connection_status",
                "provider": provider,
                "status": "connected",
            }
            return

        logger.error(
            "connection_check provider_unavailable provider=%s", provider
        )
        yield {
            "type": "error",
            "scope": "connection",
            "provider": provider,
            "code": "provider_unavailable",
            "data": ERROR_MESSAGES["provider_unavailable"],
        }
    except Exception:
        logger.exception("connection_check unexpected error provider=%s", provider)
        yield {
            "type": "error",
            "scope": "connection",
            "provider": provider,
            "code": "provider_unavailable",
            "data": ERROR_MESSAGES["provider_unavailable"],
        }


def _as_dict(result: Any) -> dict:
    if isinstance(result, dict):
        return result
    if hasattr(result, "get"):
        return result
    if hasattr(result, "model_dump"):
        return result.model_dump()
    return dict(result)


# gateway_auth からも使えるよう再エクスポート
__all__ = [
    "PROVIDER_PROBES",
    "resolve_probe",
    "run_connection_probe",
    "run_connection_check",
]
