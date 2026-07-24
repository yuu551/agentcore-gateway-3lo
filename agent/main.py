import asyncio
import logging
import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.tools.mcp import MCPClient

from connections import PROVIDER_PROBES, run_connection_check, run_connection_probe
from gateway_auth import GatewayAuthHook
from memory_session import create_session_manager

MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")

logger = logging.getLogger("agent_main")

SYSTEM_PROMPT = """あなたはユーザーのGitHubアカウント・Slackワークスペース・Googleカレンダーの情報を調べるアシスタントです。
ツールで取得した情報をもとに、日本語で簡潔に回答してください。
Markdownの表は使わず、箇条書きで整理してください。
GitHub関連でユーザー自身のログイン名が必要な場合は、先にget_me系のツールで確認してください。
Slackのチャンネルを名前で指定された場合は、先にslack_search_channelsでチャンネルIDを確認してください。
Slackへのメッセージ送信は、送信先と内容をユーザーの指示で明確に確認できる場合のみ実行してください。
カレンダーの予定はユーザーの主カレンダー（calendarId='primary'）を対象とし、
期間指定にはtimeMin/timeMax（RFC3339形式）とsingleEvents=true, orderBy='startTime'を使ってください。"""

app = BedrockAgentCoreApp()


def _bearer_token(context: RequestContext) -> str:
    headers = context.request_headers or {}
    raw_auth = headers.get("Authorization") or headers.get("authorization") or ""
    return raw_auth.removeprefix("Bearer ").removeprefix("bearer ").strip()


def _parse_operation(payload: dict) -> str:
    operation = payload.get("operation")
    if operation is None:
        return "chat"
    if operation in ("chat", "connection_probe", "connection_check"):
        return operation
    return "invalid"


async def _run_connection_operation(operation: str, provider: str, bearer_token: str):
    logger.info("invoke %s provider=%s", operation, provider)
    gateway = MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_URL, headers={"Authorization": f"Bearer {bearer_token}"}
        )
    )
    runner = (
        run_connection_check
        if operation == "connection_check"
        else run_connection_probe
    )
    with gateway:
        async for event in runner(gateway=gateway, provider=provider):
            yield event


@app.entrypoint
async def invoke(payload, context: RequestContext):
    operation = _parse_operation(payload if isinstance(payload, dict) else {})
    bearer_token = _bearer_token(context)

    if operation == "invalid":
        yield {
            "type": "error",
            "data": "このサービスは利用できません。",
            "code": "invalid_provider",
        }
        return

    if operation in ("connection_probe", "connection_check"):
        provider = payload.get("provider")
        if provider not in PROVIDER_PROBES:
            yield {
                "type": "error",
                "scope": "connection",
                "code": "invalid_provider",
                "data": "このサービスは利用できません。",
            }
            return

        async for event in _run_connection_operation(
            operation, provider, bearer_token
        ):
            yield event
        return

    # chat（後方互換: operation 省略 + prompt）
    prompt = payload.get("prompt", "") if isinstance(payload, dict) else ""

    session_manager = await asyncio.to_thread(create_session_manager, context)

    event_queue = asyncio.Queue()

    gateway = MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_URL, headers={"Authorization": f"Bearer {bearer_token}"}
        )
    )

    with gateway:
        tools = [
            t for t in gateway.list_tools_sync()
            if not t.tool_name.startswith("x_amz")
        ]

        agent = Agent(
            model=MODEL_ID,
            tools=tools,
            system_prompt=SYSTEM_PROMPT,
            hooks=[GatewayAuthHook(event_queue)],
            session_manager=session_manager,
            agent_id="default",
        )

        async def run_agent():
            seen_tool_ids = set()
            try:
                async for event in agent.stream_async(prompt):
                    if isinstance(event.get("data"), str):
                        await event_queue.put({
                            "type": "text",
                            "data": event["data"],
                        })
                    elif "current_tool_use" in event:
                        tool_use = event["current_tool_use"]
                        tool_id = tool_use.get("toolUseId", "")
                        if tool_id and tool_id not in seen_tool_ids:
                            seen_tool_ids.add(tool_id)
                            await event_queue.put({
                                "type": "tool_use",
                                "tool_name": tool_use.get("name", ""),
                            })
            except Exception as e:
                await event_queue.put({"type": "error", "data": str(e)})
            finally:
                await event_queue.put(None)

        task = asyncio.create_task(run_agent())

        while True:
            item = await event_queue.get()
            if item is None:
                break
            yield item

        await task


if __name__ == "__main__":
    app.run()
