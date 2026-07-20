"""Helpers for building an AgentCore Memory session from a Runtime request."""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from collections.abc import Mapping
from typing import Any, Optional

from bedrock_agentcore.memory.integrations.strands.config import (
    AgentCoreMemoryConfig,
)
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AGENT_ID_KEY,
    LEGACY_AGENT_PREFIX,
    MAX_FETCH_ALL_RESULTS,
    STATE_TYPE_KEY,
    AgentCoreMemorySessionManager,
    StateType,
)
from bedrock_agentcore.memory.models.filters import (
    EventMetadataFilter,
    LeftExpression,
    OperatorType,
    RightExpression,
)
from bedrock_agentcore.runtime import RequestContext
from strands.types.exceptions import SessionException
from strands.types.session import SessionAgent, SessionMessage


SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{32,99}")
ACTOR_ID_PATTERN = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_/-]*(?::[A-Za-z0-9_/-]+)*"
)


class MemorySessionConfigurationError(ValueError):
    """Raised when a Runtime request cannot be mapped to AgentCore Memory."""


def _get_header(headers: Mapping[str, str], name: str) -> str:
    """Get an HTTP header without relying on its casing."""
    expected = name.lower()
    for key, value in headers.items():
        if key.lower() == expected:
            return value
    return ""


def extract_bearer_token(headers: Mapping[str, str]) -> str:
    """Extract a bearer token from the Runtime's forwarded Authorization header.

    The Runtime Cognito authorizer validates this token before forwarding it.
    This helper only parses it; it does not replace Runtime-side signature and
    claims validation.
    """
    raw_authorization = _get_header(headers, "Authorization").strip()
    scheme, separator, token = raw_authorization.partition(" ")
    if not separator or scheme.lower() != "bearer" or not token.strip():
        raise MemorySessionConfigurationError(
            "A valid Bearer Authorization header is required"
        )
    return token.strip()


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    """Decode JWT claims after Runtime has already authenticated the token."""
    parts = token.split(".")
    if len(parts) != 3 or not parts[1]:
        raise MemorySessionConfigurationError("The Authorization token is not a JWT")

    encoded_payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        payload = base64.urlsafe_b64decode(encoded_payload)
        claims = json.loads(payload.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise MemorySessionConfigurationError(
            "The Authorization token contains an invalid JWT payload"
        ) from error

    if not isinstance(claims, dict):
        raise MemorySessionConfigurationError("The JWT payload must be an object")
    return claims


def actor_id_from_context(context: RequestContext) -> str:
    """Return the Cognito subject used as the Memory actor ID.

    The actor ID is intentionally derived from the verified Authorization
    header, never from the invocation payload supplied by the browser.
    """
    headers = context.request_headers or {}
    claims = _decode_jwt_payload(extract_bearer_token(headers))
    actor_id = claims.get("sub")
    if (
        not isinstance(actor_id, str)
        or not actor_id
        or len(actor_id) > 255
        or not ACTOR_ID_PATTERN.fullmatch(actor_id)
    ):
        raise MemorySessionConfigurationError(
            "The authenticated JWT does not contain a valid Cognito sub"
        )
    return actor_id


def _memory_settings(context: RequestContext) -> tuple[str, str, str]:
    memory_id = os.environ.get("MEMORY_ID", "").strip()
    memory_region = os.environ.get("MEMORY_REGION", "").strip()
    session_id = (context.session_id or "").strip()

    if not memory_id:
        raise MemorySessionConfigurationError("MEMORY_ID is not configured")
    if not memory_region:
        raise MemorySessionConfigurationError("MEMORY_REGION is not configured")
    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise MemorySessionConfigurationError(
            "A Runtime session ID of 33-100 valid characters is required"
        )

    return memory_id, memory_region, session_id


class StrictAgentCoreMemorySessionManager(AgentCoreMemorySessionManager):
    """AgentCore manager that does not hide short-term restore failures.

    The upstream 1.15.1 manager intentionally returns an empty state when
    ``read_agent`` or ``list_messages`` encounters an exception. For this
    application, answering without the requested conversation context is less
    safe than returning an error, so those two read paths deliberately let the
    exception propagate to the Runtime SSE error boundary.
    """

    def read_agent(
        self,
        session_id: str,
        agent_id: str,
        **kwargs: Any,
    ) -> Optional[SessionAgent]:
        if session_id != self.config.session_id:
            return None

        event_metadata = [
            EventMetadataFilter.build_expression(
                left_operand=LeftExpression.build(STATE_TYPE_KEY),
                operator=OperatorType.EQUALS_TO,
                right_operand=RightExpression.build(StateType.AGENT.value),
            ),
            EventMetadataFilter.build_expression(
                left_operand=LeftExpression.build(AGENT_ID_KEY),
                operator=OperatorType.EQUALS_TO,
                right_operand=RightExpression.build(agent_id),
            ),
        ]
        events = self.memory_client.list_events(
            memory_id=self.config.memory_id,
            actor_id=self.config.actor_id,
            session_id=session_id,
            event_metadata=event_metadata,
            max_results=1,
        )
        if events:
            agent_data = json.loads(events[0].get("payload", {})[0].get("blob"))
            agent = SessionAgent.from_dict(agent_data)
            if agent.created_at:
                self._agent_created_at_cache[agent_id] = agent.created_at
            return agent

        # Keep compatibility with events written by older Session Manager
        # versions. Any migration failure is intentionally propagated too.
        legacy_actor_id = f"{LEGACY_AGENT_PREFIX}{agent_id}"
        events = self.memory_client.list_events(
            memory_id=self.config.memory_id,
            actor_id=legacy_actor_id,
            session_id=session_id,
            max_results=1,
        )
        if not events:
            return None

        old_event = events[0]
        agent_data = json.loads(old_event.get("payload", {})[0].get("blob"))
        agent = SessionAgent.from_dict(agent_data)
        if self.persistence_mode.value != "NONE":
            self.create_agent(session_id, agent)
            self.memory_client.gmdp_client.delete_event(
                memoryId=self.config.memory_id,
                actorId=legacy_actor_id,
                sessionId=session_id,
                eventId=old_event.get("eventId"),
            )
        return agent

    def list_messages(
        self,
        session_id: str,
        agent_id: str,
        limit: Optional[int] = None,
        offset: int = 0,
        **kwargs: Any,
    ) -> list[SessionMessage]:
        if session_id != self.config.session_id:
            raise SessionException(
                f"Session ID mismatch: expected {self.config.session_id}, got {session_id}"
            )

        max_results = (limit + offset) if limit else MAX_FETCH_ALL_RESULTS
        events = self.memory_client.list_events(
            memory_id=self.config.memory_id,
            actor_id=self.config.actor_id,
            session_id=session_id,
            max_results=max_results,
        )
        messages = self.converter.events_to_messages(events)
        if self.config.filter_restored_tool_context:
            messages = self._filter_restored_tool_context(messages)
        if limit is not None:
            return messages[offset : offset + limit]
        return messages[offset:]


def create_memory_config(context: RequestContext) -> AgentCoreMemoryConfig:
    """Create the short-term memory configuration for one Runtime invocation."""
    memory_id, _memory_region, session_id = _memory_settings(context)
    return AgentCoreMemoryConfig(
        memory_id=memory_id,
        session_id=session_id,
        actor_id=actor_id_from_context(context),
        batch_size=1,
        async_mode=True,
    )


def create_memory_session_manager(
    context: RequestContext,
) -> StrictAgentCoreMemorySessionManager:
    """Create a Strands Session Manager for the current user and conversation."""
    _memory_id, memory_region, _session_id = _memory_settings(context)
    return StrictAgentCoreMemorySessionManager(
        agentcore_memory_config=create_memory_config(context),
        region_name=memory_region,
    )
