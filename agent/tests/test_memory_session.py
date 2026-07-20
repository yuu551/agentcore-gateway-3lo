import base64
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bedrock_agentcore.runtime import RequestContext

from memory_session import (
    MemorySessionConfigurationError,
    actor_id_from_context,
    create_memory_config,
    create_memory_session_manager,
    StrictAgentCoreMemorySessionManager,
)


SESSION_ID = "12345678-1234-4234-8234-123456789012"


def jwt_for(subject: str) -> str:
    def encode(value: object) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    return f"{encode({'alg': 'RS256', 'typ': 'JWT'})}.{encode({'sub': subject})}.signature"


def request_context(
    token: str | None = None,
    session_id: str | None = SESSION_ID,
) -> RequestContext:
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return RequestContext(session_id=session_id, request_headers=headers)


class MemorySessionTests(unittest.TestCase):
    def test_actor_id_comes_from_authenticated_jwt_sub(self) -> None:
        context = request_context(jwt_for("cognito-user-123"))

        self.assertEqual(actor_id_from_context(context), "cognito-user-123")

    def test_missing_or_malformed_authorization_is_rejected(self) -> None:
        cases = [
            request_context(),
            request_context("not-a-jwt"),
            request_context("header.invalid.signature"),
        ]

        for context in cases:
            with self.subTest(context=context):
                with self.assertRaises(MemorySessionConfigurationError):
                    actor_id_from_context(context)

    def test_missing_memory_settings_or_session_is_rejected(self) -> None:
        context = request_context(jwt_for("cognito-user-123"))
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(MemorySessionConfigurationError):
                create_memory_config(context)

        with patch.dict(
            os.environ,
            {"MEMORY_ID": "memory-id", "MEMORY_REGION": "us-east-1"},
            clear=True,
        ):
            invalid_context = request_context(
                jwt_for("cognito-user-123"), session_id="too-short"
            )
            with self.assertRaises(MemorySessionConfigurationError):
                create_memory_config(invalid_context)

    def test_session_manager_receives_user_and_conversation_scope(self) -> None:
        context = request_context(jwt_for("cognito-user-123"))
        with patch.dict(
            os.environ,
            {"MEMORY_ID": "memory-id", "MEMORY_REGION": "us-east-1"},
            clear=True,
        ), patch("memory_session.StrictAgentCoreMemorySessionManager") as manager:
            create_memory_session_manager(context)

        config = manager.call_args.kwargs["agentcore_memory_config"]
        self.assertEqual(config.memory_id, "memory-id")
        self.assertEqual(config.session_id, SESSION_ID)
        self.assertEqual(config.actor_id, "cognito-user-123")
        self.assertEqual(config.batch_size, 1)
        self.assertTrue(config.async_mode)
        self.assertEqual(manager.call_args.kwargs["region_name"], "us-east-1")

    def test_payload_values_cannot_change_actor_scope(self) -> None:
        context = request_context(jwt_for("cognito-user-123"))
        payload = {"prompt": "hello", "actor_id": "attacker"}

        with patch.dict(
            os.environ,
            {"MEMORY_ID": "memory-id", "MEMORY_REGION": "us-east-1"},
            clear=True,
        ):
            config = create_memory_config(context)

        self.assertEqual(config.actor_id, "cognito-user-123")
        self.assertNotEqual(config.actor_id, payload["actor_id"])
    def test_restore_list_errors_are_not_converted_to_empty_history(self) -> None:
        manager = object.__new__(StrictAgentCoreMemorySessionManager)
        manager.config = SimpleNamespace(
            memory_id="memory-id",
            actor_id="cognito-user-123",
            session_id=SESSION_ID,
            filter_restored_tool_context=False,
        )
        manager.memory_client = Mock()
        manager.memory_client.list_events.side_effect = RuntimeError("memory unavailable")

        with self.assertRaisesRegex(RuntimeError, "memory unavailable"):
            manager.list_messages(SESSION_ID, "default")


if __name__ == "__main__":
    unittest.main()
