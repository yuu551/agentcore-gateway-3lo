import asyncio
import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.tools.mcp import MCPClient

from gateway_auth import GatewayAuthHook
from memory_session import create_session_manager

MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")

SYSTEM_PROMPT = """あなたはユーザーのGitHubアカウント・Slackワークスペース・Googleカレンダーの情報を調べるアシスタントです。
ツールで取得した情報をもとに、日本語で簡潔に回答してください。
Markdownの表は使わず、箇条書きで整理してください。
GitHub関連でユーザー自身のログイン名が必要な場合は、先にget_me系のツールで確認してください。
Slackのチャンネルを名前で指定された場合は、先にslack_search_channelsでチャンネルIDを確認してください。
Slackへのメッセージ送信は、送信先と内容をユーザーの指示で明確に確認できる場合のみ実行してください。
カレンダーの予定はユーザーの主カレンダー（calendarId='primary'）を対象とし、
期間指定にはtimeMin/timeMax（RFC3339形式）とsingleEvents=true, orderBy='startTime'を使ってください。"""

app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke(payload, context: RequestContext):
    prompt = payload.get("prompt", "")

    headers = context.request_headers or {}
    raw_auth = headers.get("Authorization") or headers.get("authorization") or ""
    bearer_token = raw_auth.removeprefix("Bearer ").removeprefix("bearer ").strip()

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
