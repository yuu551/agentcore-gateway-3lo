"""AgentCore Memory の Session Manager をランタイムリクエストから構築する。"""

import os

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import (
    AgentCoreMemorySessionManager,
)
from bedrock_agentcore.runtime import RequestContext


def _bearer_token(headers: dict) -> str:
    raw = headers.get("Authorization") or headers.get("authorization") or ""
    return raw.removeprefix("Bearer ").removeprefix("bearer ").strip()


def _jwt_sub(token: str) -> str:
    """JWTのペイロードからsub（Cognitoユーザー ID）を取り出す。"""
    import base64, json
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))["sub"]


def create_session_manager(context: RequestContext) -> AgentCoreMemorySessionManager:
    """1リクエスト分のSession Managerを生成する。"""
    headers = context.request_headers or {}
    token = _bearer_token(headers)
    actor_id = _jwt_sub(token)

    config = AgentCoreMemoryConfig(
        memory_id=os.environ["MEMORY_ID"],
        session_id=context.session_id,
        actor_id=actor_id,
    )
    return AgentCoreMemorySessionManager(
        agentcore_memory_config=config,
        region_name=os.environ.get("MEMORY_REGION", "us-east-1"),
    )
