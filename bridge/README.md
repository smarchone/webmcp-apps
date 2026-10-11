# WebMCP bridge

A generic, dependency-free stdio MCP server. Add it to any Claude Code session and that session can use the
WebMCP tools (`document.modelContext`) of any web page. Every app in this repo points its `.mcp.json` here.

```
 terminal: claude ──stdio MCP──► webmcp-bridge ──Chrome DevTools Protocol──► Chrome tab
                                                                              │
                                                     injects interceptor.js   ▼
                                               any page: document.modelContext.registerTool(...)
```

## Using it with any session or page

Add it to Claude Code from any directory:

```bash
claude mcp add webmcp -- node /absolute/path/to/webmcp-apps/bridge/webmcp-bridge.mjs
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
- It attaches to every tab and injects `interceptor.js` before page scripts run. The interceptor
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
