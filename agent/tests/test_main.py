import asyncio
import unittest
from unittest.mock import Mock, patch

from bedrock_agentcore.runtime import RequestContext

import main


class FakeGateway:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def list_tools_sync(self):
        return [Mock(tool_name="github_search")]


class FakeAgent:
    async def stream_async(self, prompt):
        self.prompt = prompt
        yield {"data": "remembered response"}


class BlockingAgent:
    async def stream_async(self, prompt):
        yield {"data": "first response"}
        await asyncio.Future()


class MainInvocationTests(unittest.IsolatedAsyncioTestCase):
    async def test_memory_session_manager_is_injected_without_changing_sse(self):
        manager = Mock()
        gateway = FakeGateway()
        agent = FakeAgent()
        context = RequestContext(
            session_id="12345678-1234-4234-8234-123456789012",
            request_headers={"Authorization": "Bearer token"},
        )

        with patch.object(
            main, "extract_bearer_token", return_value="token"
        ), patch.object(
            main, "create_memory_session_manager", return_value=manager
        ), patch.object(main, "MCPClient", return_value=gateway), patch.object(
            main, "Agent", return_value=agent
        ) as agent_factory:
            events = [
                event
                async for event in main.invoke({"prompt": "hello"}, context)
            ]

        self.assertEqual(events, [{"type": "text", "data": "remembered response"}])
        agent_factory.assert_called_once()
        self.assertIs(agent_factory.call_args.kwargs["session_manager"], manager)
        self.assertEqual(agent_factory.call_args.kwargs["agent_id"], "default")
        manager.close.assert_called_once_with()
    async def test_memory_initialization_failure_is_an_sse_error(self):
        manager_error = RuntimeError("memory API unavailable")
        context = RequestContext(
            session_id="12345678-1234-4234-8234-123456789012",
            request_headers={"Authorization": "Bearer token"},
        )

        with patch.object(
            main, "extract_bearer_token", return_value="token"
        ), patch.object(
            main,
            "create_memory_session_manager",
            side_effect=manager_error,
        ):
            events = [
                event
                async for event in main.invoke({"prompt": "hello"}, context)
            ]

        self.assertEqual(
            events,
            [{"type": "error", "data": "memory API unavailable"}],
        )

    async def test_client_disconnect_cancels_agent_before_manager_close(self):
        manager = Mock()
        gateway = FakeGateway()
        context = RequestContext(
            session_id="12345678-1234-4234-8234-123456789012",
            request_headers={"Authorization": "Bearer token"},
        )
        invocation = None

        with patch.object(
            main, "extract_bearer_token", return_value="token"
        ), patch.object(
            main, "create_memory_session_manager", return_value=manager
        ), patch.object(main, "MCPClient", return_value=gateway), patch.object(
            main, "Agent", return_value=BlockingAgent()
        ):
            invocation = main.invoke({"prompt": "hello"}, context)
            first_event = await anext(invocation)
            self.assertEqual(first_event["type"], "text")
            await invocation.aclose()

        manager.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
