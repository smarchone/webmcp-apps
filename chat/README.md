# WebMCP Chat

A chat page that is just a WebMCP site. It has no backend and no Claude-specific code. It registers tools
like `chat_wait_for_messages` and `chat_send_message`, so whichever agent connects can be its assistant. Your
local Claude Code session answers the chat by calling those tools through the shared
[WebMCP bridge](../bridge/README.md).

## Quick start

```bash
cd chat
npm start                 # serves the chat page at http://127.0.0.1:3456
```

In another terminal, start Claude Code **in `chat/`**. It picks up `.mcp.json` and asks you to approve the
`webmcp` server. Then run:

```
/webmcp-chat
```

Claude opens the page in a Chrome window controlled by the bridge, then waits for your messages there. Type
in the page and Claude answers in the page. It can use the page's tools (todos, notes, theme) and its normal
Claude Code tools. Send "bye" in the chat to end the loop.

Tip: allow `mcp__webmcp` in `/permissions` so Claude doesn't ask for approval on every poll.

See [`bridge/README.md`](../bridge/README.md) for the bridge tools, how it works, and how to make your own
page WebMCP-enabled.
