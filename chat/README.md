# WebMCP Chat

Two parts:

1. **`bridge/`**: a generic WebMCP bridge. It's an MCP server you add to any Claude Code session, and it
   lets that session use the WebMCP tools (`document.modelContext`) of any web page.
2. **`app/`**: a chat page that is just a WebMCP site. It has no backend and no Claude-specific code. It
   registers tools like `chat_wait_for_messages` and `chat_send_message`, so whichever agent connects can
   be its assistant. Your local Claude Code session answers the chat by calling those tools.

```
 terminal: claude ──stdio MCP──► webmcp-bridge ──Chrome DevTools Protocol──► Chrome tab
                                                                              │
                                                     injects interceptor.js   ▼
                                               any page: document.modelContext.registerTool(...)
```

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

## Using the bridge with any session or page

Add it to Claude Code from any directory:

```bash
claude mcp add webmcp -- node /absolute/path/to/chat/bridge/webmcp-bridge.mjs
```

Bridge tools:

| Tool                | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `browser_open_page` | Open a URL and return the WebMCP tools the page registered       |
| `browser_list_tabs` | List tabs and each page's tool names                             |
| `page_list_tools`   | Full tool descriptions and input schemas for a tab               |
| `page_call_tool`    | Call a page tool (`tab` is optional when only one tab has tools) |

How it works:

- The bridge launches a dedicated Chrome (profile in `~/.webmcp-bridge/chrome-profile`) with remote debugging.
  The browser stays open and is reused by later sessions.
- It attaches to every tab and injects `bridge/interceptor.js` before page scripts run. The interceptor
  provides `document.modelContext` when the browser lacks it. With native WebMCP, it passes calls through to
  the browser. Either way it records the registered tools so the bridge can list and call them.
  Pages that still use the deprecated `navigator.modelContext` spelling get an alias to the same object.
- Tabs you open yourself in that window are covered too. A page that was already loaded when the bridge
  attached needs a reload before its tools appear.

Environment variables: `CHROME_PATH` (Chrome/Chromium binary) and `WEBMCP_PROFILE_DIR` (browser profile dir).

## Making your own page WebMCP-enabled

```js
const controller = new AbortController(); // controller.abort() unregisters the tool
await document.modelContext.registerTool({
  name: 'search_products',
  description: 'Search the catalog',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async execute({ query }) {
    return { content: [{ type: 'text', text: JSON.stringify(await search(query)) }] };
  },
}, { signal: controller.signal });
```

Requires Node 22+ (for the built-in `WebSocket`) and Chrome or another Chromium browser. There are no npm
dependencies.
