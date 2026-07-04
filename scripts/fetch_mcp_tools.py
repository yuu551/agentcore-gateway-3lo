import asyncio
import json
import os

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

PICK = ["get_me", "search_repositories", "list_commits",
        "list_pull_requests", "search_code", "search_issues"]
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


async def main():
    headers = {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"}
    tools = []
    async with streamablehttp_client(
        "https://api.githubcopilot.com/mcp/", headers=headers
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

    curated = [
        {
            "name": t.name,
            "description": t.description or t.name,
            "inputSchema": sanitize(t.inputSchema),
        }
        for t in tools
        if t.name in PICK
    ]
    with open("amplify/github-mcp-tools.json", "w") as f:
        json.dump({"tools": curated}, f, ensure_ascii=False, indent=2)
    print(f"{len(curated)} tools written")


asyncio.run(main())
