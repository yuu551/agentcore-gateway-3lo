"""connections.run_connection_probe の単体テスト。"""

from __future__ import annotations

import asyncio
import unittest
from typing import Any
from unittest.mock import MagicMock

from connections import (
    PROVIDER_PROBES,
    resolve_probe,
    run_connection_check,
    run_connection_probe,
)
from gateway_auth import ELICITATION_MARKER


def _elicitation_result(url: str = "https://example.com/oauth") -> dict[str, Any]:
    payload = f'{ELICITATION_MARKER}: [err] with data [{{"url": "{url}"}}]'
    return {
        "status": "error",
        "content": [{"text": payload}],
    }


class FakeGateway:
    def __init__(self, results: list[Any], tool_names: set[str] | None = None):
        self._results = list(results)
        self._tool_names = tool_names or {name for name, _ in PROVIDER_PROBES.values()}
        self.calls: list[tuple[str, dict | None]] = []

    def list_tools_sync(self):
        return [MagicMock(tool_name=name) for name in self._tool_names]

    async def call_tool_async(self, tool_use_id: str, name: str, arguments=None):
        self.calls.append((name, arguments))
        if not self._results:
            raise AssertionError("unexpected tool call")
        return self._results.pop(0)


async def _collect(provider: str, gateway: FakeGateway, **kwargs):
    events = []
    async for event in run_connection_probe(
        gateway=gateway,
        provider=provider,
        sleep=kwargs.get("sleep", _noop_sleep),
        poll_interval=kwargs.get("poll_interval", 0),
        deadline_seconds=kwargs.get("deadline_seconds", 300),
    ):
        events.append(event)
    return events


async def _noop_sleep(_seconds: float):
    return None


class ConnectionProbeTests(unittest.TestCase):
    def test_resolve_probe_mapping(self):
        tool, args = resolve_probe("github")
        self.assertEqual(tool, "githubmcp___get_me")
        self.assertEqual(args, {})

        tool, args = resolve_probe("slack")
        self.assertEqual(tool, "slackmcp___slack_search_channels")
        self.assertIn("query", args)

        tool, args = resolve_probe("google_calendar")
        self.assertEqual(tool, "googlecal___listCalendars")

        self.assertIsNone(resolve_probe("twitter"))

    def test_unknown_provider(self):
        events = asyncio.run(_collect("twitter", FakeGateway([])))
        self.assertEqual(events[0]["code"], "invalid_provider")

    def test_success_emits_connected_without_tool_body(self):
        gateway = FakeGateway([{"status": "success", "content": [{"text": "me"}]}])
        events = asyncio.run(_collect("github", gateway))
        self.assertEqual(
            events,
            [
                {"type": "connection_status", "provider": "github", "status": "checking"},
                {"type": "connection_status", "provider": "github", "status": "connected"},
            ],
        )
        self.assertEqual(gateway.calls[0][0], "githubmcp___get_me")

    def test_elicitation_emits_auth_required_once(self):
        gateway = FakeGateway(
            [
                _elicitation_result(),
                _elicitation_result(),
                {"status": "success", "content": []},
            ]
        )
        events = asyncio.run(_collect("slack", gateway, poll_interval=0))
        auth_events = [e for e in events if e["type"] == "auth_required"]
        self.assertEqual(len(auth_events), 1)
        self.assertEqual(auth_events[0]["provider"], "slack")
        self.assertTrue(auth_events[0]["auth_url"].startswith("https://"))
        self.assertEqual(events[-1]["status"], "connected")

    def test_authorization_timeout(self):
        gateway = FakeGateway([_elicitation_result(), _elicitation_result()])

        async def run():
            events = []
            async for event in run_connection_probe(
                gateway=gateway,
                provider="github",
                sleep=_noop_sleep,
                poll_interval=0,
                deadline_seconds=0,
            ):
                events.append(event)
            return events

        events = asyncio.run(run())
        self.assertEqual(events[-1]["code"], "authorization_timeout")

    def test_provider_unavailable(self):
        gateway = FakeGateway(
            [{"status": "error", "content": [{"text": "boom"}]}]
        )
        events = asyncio.run(_collect("github", gateway))
        self.assertEqual(events[-1]["code"], "provider_unavailable")

    def test_probe_tool_missing(self):
        gateway = FakeGateway([], tool_names={"other___tool"})
        events = asyncio.run(_collect("github", gateway))
        self.assertEqual(events[0]["code"], "probe_tool_missing")


class ConnectionCheckTests(unittest.TestCase):
    def test_calls_tool_once_and_does_not_retry(self):
        gateway = FakeGateway(
            [
                _elicitation_result(),
                {"status": "success", "content": []},
            ]
        )

        async def run():
            events = []
            async for event in run_connection_check(
                gateway=gateway, provider="github"
            ):
                events.append(event)
            return events

        events = asyncio.run(run())
        self.assertEqual(len(gateway.calls), 1)
        self.assertEqual(
            events,
            [
                {
                    "type": "connection_status",
                    "provider": "github",
                    "status": "checking",
                },
                {
                    "type": "connection_status",
                    "provider": "github",
                    "status": "not_connected",
                },
            ],
        )
        self.assertFalse(any(e.get("type") == "auth_required" for e in events))
        self.assertFalse(any("auth_url" in e for e in events))

    def test_success_emits_connected(self):
        gateway = FakeGateway([{"status": "success", "content": []}])

        async def run():
            events = []
            async for event in run_connection_check(
                gateway=gateway, provider="slack"
            ):
                events.append(event)
            return events

        events = asyncio.run(run())
        self.assertEqual(events[-1]["status"], "connected")
        self.assertEqual(len(gateway.calls), 1)

    def test_provider_unavailable(self):
        gateway = FakeGateway(
            [{"status": "error", "content": [{"text": "boom"}]}]
        )

        async def run():
            events = []
            async for event in run_connection_check(
                gateway=gateway, provider="github"
            ):
                events.append(event)
            return events

        events = asyncio.run(run())
        self.assertEqual(events[-1]["code"], "provider_unavailable")


if __name__ == "__main__":
    unittest.main()
