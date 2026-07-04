import asyncio
import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.tools.mcp import MCPClient

from gateway_auth import GatewayAuthHook

MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"

# Runtimeの環境変数から取得（backend.tsのenvironmentVariablesで注入）
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")

SYSTEM_PROMPT = """あなたはユーザーのGitHubアカウントの情報を調べるアシスタントです。
ツールで取得した情報をもとに、日本語で簡潔に回答してください。
Markdownの表は使わず、箇条書きで整理してください。
ユーザー自身のログイン名が必要な場合は、先にget_me系のツールで確認してください。"""

app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke(payload, context: RequestContext):
    prompt = payload.get("prompt", "")

    headers = context.request_headers or {}
    raw_auth = headers.get("Authorization") or headers.get("authorization") or ""
    bearer_token = raw_auth.removeprefix("Bearer ").removeprefix("bearer ").strip()

    event_queue = asyncio.Queue()

    # GatewayはエージェントからはただのMCPサーバー。
    # ユーザーのJWTをそのまま渡して接続する（JWTパススルー）
    gateway = MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_URL, headers={"Authorization": f"Bearer {bearer_token}"}
        )
    )

    with gateway:
        # Gateway組み込みのセマンティック検索ツールは除外する
        tools = [
            t for t in gateway.list_tools_sync()
            if not t.tool_name.startswith("x_amz")
        ]

        agent = Agent(
            model=MODEL_ID,
            tools=tools,
            system_prompt=SYSTEM_PROMPT,
            hooks=[GatewayAuthHook(event_queue)],
        )

        async def run_agent():
            seen_tool_ids = set()  # 同一ツール呼び出しの重複通知を防ぐ
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
