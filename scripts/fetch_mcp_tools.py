"""リモートMCPサーバーからツール定義を取得し、Gateway用の静的スキーマJSONを生成する。

使い方:
  GitHub: GITHUB_TOKEN=<token> uv run python scripts/fetch_mcp_tools.py github
  Slack:  SLACK_TOKEN=<xoxp-token> uv run python scripts/fetch_mcp_tools.py slack
  全ツール確認（選定前の一覧出力のみ）: ... fetch_mcp_tools.py slack --list
"""
import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

SERVERS = {
    "github": {
        "endpoint": "https://api.githubcopilot.com/mcp/",
        "token_env": "GITHUB_TOKEN",
        "output": "amplify/github-mcp-tools.json",
        "pick": ["get_me", "search_repositories", "list_commits",
                 "list_pull_requests", "search_code", "search_issues"],
    },
    "slack": {
        "endpoint": "https://mcp.slack.com/mcp",
        "token_env": "SLACK_TOKEN",
        "output": "amplify/slack-mcp-tools.json",
        "pick": ["slack_search_channels", "slack_search_public",
                 "slack_read_channel", "slack_read_thread",
                 "slack_send_message"],
    },
}

ALLOWED = {"type", "properties", "required", "items", "description"}


def sanitize(schema):
    if not isinstance(schema, dict):
        return schema
    out = {}
    for k, v in schema.items():
        if k not in ALLOWED:
            continue
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: sanitize(pv) for pk, pv in v.items()}
        elif k == "items":
            out[k] = sanitize(v)
        else:
            out[k] = v
    out.setdefault("type", "object")
    return out


async def main(server: dict, list_only: bool):
    headers = {"Authorization": f"Bearer {os.environ[server['token_env']]}"}
    tools = []
    async with streamablehttp_client(
        server["endpoint"], headers=headers
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            cursor = None
            while True:
                result = await session.list_tools(cursor=cursor)
                tools.extend(result.tools)
                cursor = result.nextCursor
                if not cursor:
                    break

    if list_only or not server["pick"]:
        print(f"=== {server['endpoint']} のツール一覧（{len(tools)}件） ===")
        for t in tools:
            print(f"  - {t.name}: {(t.description or '').splitlines()[0][:80]}")
        if not server["pick"]:
            print("\npickが未設定のため出力ファイルは生成していません。"
                  "SERVERSのpickにツール名を設定してください。")
        return

    curated = [
        {
            "name": t.name,
            "description": t.description or t.name,
            "inputSchema": sanitize(t.inputSchema),
        }
        for t in tools
        if t.name in server["pick"]
    ]
    missing = set(server["pick"]) - {t["name"] for t in curated}
    if missing:
        print(f"警告: 見つからなかったツール: {sorted(missing)}")
    with open(server["output"], "w") as f:
        json.dump({"tools": curated}, f, ensure_ascii=False, indent=2)
    print(f"{len(curated)} tools written to {server['output']}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args or args[0] not in SERVERS:
        print(f"Usage: python scripts/fetch_mcp_tools.py {{{'|'.join(SERVERS)}}} [--list]")
        sys.exit(1)
    asyncio.run(main(SERVERS[args[0]], "--list" in sys.argv))
