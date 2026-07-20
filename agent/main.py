import asyncio
import logging
import os

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from mcp.client.streamable_http import streamablehttp_client
from strands import Agent
from strands.tools.mcp import MCPClient

from gateway_auth import GatewayAuthHook
from memory_session import (
    MemorySessionConfigurationError,
    create_memory_session_manager,
    extract_bearer_token,
)

MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"

# Runtimeの環境変数から取得（backend.tsのenvironmentVariablesで注入）
GATEWAY_URL = os.environ.get("GATEWAY_URL", "")
logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """あなたはユーザーのGitHubアカウント・Slackワークスペース・Googleカレンダーの情報を調べるアシスタントです。
ツールで取得した情報をもとに、日本語で簡潔に回答してください。
Markdownの表は使わず、箇条書きで整理してください。
GitHub関連でユーザー自身のログイン名が必要な場合は、先にget_me系のツールで確認してください。
Slackのチャンネルを名前で指定された場合は、先にslack_search_channelsでチャンネルIDを確認してください。
Slackへのメッセージ送信は、送信先と内容をユーザーの指示で明確に確認できる場合のみ実行してください。
カレンダーの予定はユーザーの主カレンダー（calendarId='primary'）を対象とし、
期間指定にはtimeMin/timeMax（RFC3339形式）とsingleEvents=true, orderBy='startTime'を使ってください。"""

app = BedrockAgentCoreApp()


def _list_gateway_tools(gateway: MCPClient):
    """List user-facing Gateway tools without blocking the async Runtime loop."""
    return [
        tool for tool in gateway.list_tools_sync()
        if not tool.tool_name.startswith("x_amz")
    ]


@app.entrypoint
async def invoke(payload, context: RequestContext):
    prompt = payload.get("prompt", "")
    headers = context.request_headers or {}

    try:
        bearer_token = extract_bearer_token(headers)
        # Session Managerのコンストラクタも既存セッションを読むためAWS同期I/Oを行う。
        session_manager = await asyncio.to_thread(
            create_memory_session_manager, context
        )
    except MemorySessionConfigurationError as error:
        logger.error("Memory session configuration failed: %s", error)
        yield {"type": "error", "data": str(error)}
        return
    except Exception as error:
        logger.exception("Memory session initialization failed")
        yield {"type": "error", "data": str(error)}
        return

    event_queue = asyncio.Queue()

    # GatewayはエージェントからはただのMCPサーバー。
    # ユーザーのJWTをそのまま渡して接続する（JWTパススルー）
    gateway = MCPClient(
        lambda: streamablehttp_client(
            GATEWAY_URL, headers={"Authorization": f"Bearer {bearer_token}"}
        )
    )

    task: asyncio.Task | None = None
    try:
        with gateway:
            # Gateway組み込みのセマンティック検索ツールは除外する
            tools = await asyncio.to_thread(_list_gateway_tools, gateway)

            # Session Managerの初期化では短期Memoryから会話を同期的に読むため、
            # Agent構築をワーカースレッドで行い、Runtimeのイベントループを塞がない。
            agent = await asyncio.to_thread(
                Agent,
                model=MODEL_ID,
                tools=tools,
                system_prompt=SYSTEM_PROMPT,
                hooks=[GatewayAuthHook(event_queue)],
                session_manager=session_manager,
                agent_id="default",
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
                except Exception as error:
                    await event_queue.put({"type": "error", "data": str(error)})
                finally:
                    await event_queue.put(None)

            task = asyncio.create_task(run_agent())

            try:
                while True:
                    item = await event_queue.get()
                    if item is None:
                        break
                    yield item

                await task
            finally:
                if task is not None:
                    if not task.done():
                        task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        logger.exception("Agent task failed during cleanup")
    except Exception as error:
        logger.exception("Agent invocation failed")
        yield {"type": "error", "data": str(error)}
    finally:
        # batch_size=1でも、Session Managerのリソースを明示的に終了する。
        try:
            await asyncio.to_thread(session_manager.close)
        except Exception:
            logger.exception("Failed to close AgentCore Memory session manager")


if __name__ == "__main__":
    app.run()
