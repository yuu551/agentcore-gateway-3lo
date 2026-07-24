"""gateway_auth.GatewayAuthHook の単体テスト。"""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import MagicMock

from gateway_auth import (
    ELICITATION_MARKER,
    GatewayAuthHook,
    extract_auth_url,
    provider_from_tool_name,
)


def _elicitation_result(url: str = "https://example.com/oauth"):
    return {
        "status": "error",
        "content": [
            {
                "text": f'{ELICITATION_MARKER}: [err] with data [{{"url": "{url}"}}]',
            }
        ],
    }


class ProviderResolutionTests(unittest.TestCase):
    def test_provider_from_tool_name(self):
        self.assertEqual(provider_from_tool_name("githubmcp___get_me"), "github")
        self.assertEqual(
            provider_from_tool_name("slackmcp___slack_search_channels"), "slack"
        )
        self.assertEqual(
            provider_from_tool_name("googlecal___listCalendars"),
            "google_calendar",
        )
        self.assertIsNone(provider_from_tool_name("unknown___tool"))

    def test_extract_auth_url(self):
        url = extract_auth_url(_elicitation_result("https://secure.example/a"))
        self.assertEqual(url, "https://secure.example/a")
        self.assertIsNone(
            extract_auth_url({"status": "success", "content": [{"text": "ok"}]})
        )


class GatewayAuthHookTests(unittest.IsolatedAsyncioTestCase):
    async def test_notifies_per_provider(self):
        queue: asyncio.Queue = asyncio.Queue()
        hook = GatewayAuthHook(queue)

        event1 = MagicMock()
        event1.tool_use = {"name": "githubmcp___get_me"}
        event1.result = _elicitation_result("https://github.com/login")
        event1.retry = False

        # sleep を即時化
        import gateway_auth

        original_sleep = gateway_auth.asyncio.sleep

        async def fast_sleep(_):
            return None

        gateway_auth.asyncio.sleep = fast_sleep
        try:
            await hook._on_after_tool_call(event1)
            self.assertTrue(event1.retry)
            first = await queue.get()
            self.assertEqual(first["type"], "auth_required")
            self.assertEqual(first["provider"], "github")

            # 同じ provider では再通知しない
            event1b = MagicMock()
            event1b.tool_use = {"name": "githubmcp___get_me"}
            event1b.result = _elicitation_result("https://github.com/login")
            event1b.retry = False
            await hook._on_after_tool_call(event1b)
            self.assertTrue(queue.empty())

            # 別 provider は通知する
            event2 = MagicMock()
            event2.tool_use = {"name": "slackmcp___slack_search_channels"}
            event2.result = _elicitation_result("https://slack.com/oauth")
            event2.retry = False
            await hook._on_after_tool_call(event2)
            second = await queue.get()
            self.assertEqual(second["provider"], "slack")
        finally:
            gateway_auth.asyncio.sleep = original_sleep

    async def test_emits_connected_after_success(self):
        queue: asyncio.Queue = asyncio.Queue()
        hook = GatewayAuthHook(queue)
        hook._notified_providers.add("github")

        event = MagicMock()
        event.tool_use = {"name": "githubmcp___get_me"}
        event.result = {"status": "success", "content": []}
        await hook._on_after_tool_call(event)

        item = await queue.get()
        self.assertEqual(
            item,
            {
                "type": "connection_status",
                "provider": "github",
                "status": "connected",
            },
        )

    async def test_emits_authorization_timeout(self):
        queue: asyncio.Queue = asyncio.Queue()
        hook = GatewayAuthHook(queue)
        hook._notified_providers.add("github")
        hook._deadlines["github"] = 0  # すでに期限切れ

        event = MagicMock()
        event.tool_use = {"name": "githubmcp___get_me"}
        event.result = _elicitation_result("https://github.com/login")
        event.retry = False
        await hook._on_after_tool_call(event)

        self.assertFalse(event.retry)
        item = await queue.get()
        self.assertEqual(item["type"], "error")
        self.assertEqual(item["code"], "authorization_timeout")
        self.assertEqual(item["provider"], "github")
        self.assertEqual(item["scope"], "chat")


if __name__ == "__main__":
    unittest.main()
