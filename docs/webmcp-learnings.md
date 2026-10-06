# WebMCP learnings

Notes from building `chat/`, a WebMCP chat page plus a bridge that lets a local Claude Code session drive it.
Last updated 2026-10-06.

## 1. What WebMCP is (and isn't)

- **WebMCP lets a web page describe actions an agent can take.** The page registers tools in the browser, and
  whatever agent is connected to that browser can call them.
- **The page should know nothing about the agent.** Our first version spawned `claude -p` from a Node server
  behind the page. That's a wrapper around the Claude Code CLI, not WebMCP. The point is that a standalone
  agent session can interact with any page that exposes tools.
- **The right split has three independent parts:**
  1. The page: registers tools and has no backend logic.
  2. A bridge: connects the browser to the agent.
  3. The agent: a normal Claude Code session.

## 2. The API (current spec)

Spec: https://webmachinelearning.github.io/webmcp/ (W3C Community Group draft, still changing).

- **It's `document.modelContext`, not `navigator.modelContext`.** The API moved in mid-2026, and Chrome 150
  deprecated the `navigator` spelling. Most tutorials still show the old one.
- **Feature check:** `if ('modelContext' in document) { ... }`
- **Chrome status:** origin trial from Chrome 149 through 156.

```webidl
interface ModelContext : EventTarget {
  Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {});
  Promise<sequence<RegisteredTool>> getTools(optional ModelContextGetToolOptions options = {});
  Promise<DOMString> executeTool(RegisteredTool tool, optional object inputObject, optional ModelContextExecuteToolOptions options = {});
  attribute EventHandler ontoolchange;
  attribute EventHandler ontoolactivated;
  attribute EventHandler ontoolcancel;
};
// ModelContextTool: { name, title?, description, inputSchema?, execute(input, { signal }), annotations? }
// RegisterToolOptions: { exposedTo?: origins[], signal?: AbortSignal }
```

Things that changed from older versions:

| Old                                          | Current                                                        |
| -------------------------------------------- | -------------------------------------------------------------- |
| `navigator.modelContext`                     | `document.modelContext`                                        |
| `registerTool()` returns `{ unregister() }`  | returns a Promise; abort the `signal` to unregister            |
| `provideContext`, `unregisterTool`, `clearContext` | removed                                                  |
| (none)                                       | `getTools()`, `executeTool(tool, input)` (resolves to a string) |
| `execute(input, client)`                     | `execute(input, { signal })`                                   |

Example:

```js
const controller = new AbortController(); // controller.abort() unregisters the tool
await document.modelContext.registerTool({
  name: 'add_todos',
  description: "Add items to the user's todo list.",
  inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] },
  async execute({ items }) { /* ... */ return { added: items.length }; },
}, { signal: controller.signal });
```

## 3. Connecting Claude Code to page tools: the bridge

Claude Code can't reach into a browser tab, but it can talk to MCP servers. So the bridge
(`chat/bridge/webmcp-bridge.mjs`) is a stdio MCP server that also controls Chrome through the
Chrome DevTools Protocol (CDP).

**Flow:** `claude` → stdio MCP → bridge → CDP → Chrome tab → `document.modelContext`

**The interceptor** (`chat/bridge/interceptor.js`) is injected into every tab before the page's own scripts run:
- It wraps `registerTool` so every registered tool is recorded, and passes the call through to native WebMCP
  when the browser has it.
- Without native WebMCP, it provides a minimal `document.modelContext` (`registerTool`, `getTools`, `executeTool`).
- It adds `navigator.modelContext` as an alias for pages still using the old spelling.
- It exposes `window.__webmcpBridge.list()` and `.call(name, args)` for the bridge to use.

**The bridge gives Claude four tools:** `browser_open_page`, `browser_list_tabs`, `page_list_tools` and
`page_call_tool`. Generic tools are more robust than re-exposing each page tool as its own MCP tool, because
pages come and go during a session.

## 4. CDP gotchas (each cost real debugging time)

1. **`Page.addScriptToEvaluateOnNewDocument` does nothing unless `Page.enable` runs first on that session.**
   There's no error; the script just never runs.
2. **Opening a tab directly at the target URL is too fast.** The page loads before the script is injected.
   Fix: open `about:blank`, wait until injection is done, then `Page.navigate` to the real URL.
3. **Browser-level `Target.setAutoAttach` with `waitForDebuggerOnStart: true` pauses new targets.** Each one
   must be resumed with `Runtime.runIfWaitingForDebugger`, including non-page targets (workers), which should
   then be detached. Otherwise they hang.
4. **Also attach to tabs that already exist** (`Target.getTargets` + `attachToTarget`). Tools those pages
   registered before the bridge attached can't be recovered, so the page needs a reload.
5. **Background tabs get timer throttling.** Launch Chrome with `--disable-background-timer-throttling`,
   `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`.
6. **Recent Chrome needs a separate `--user-data-dir` for remote debugging.** Use
   `--remote-debugging-port=0` and read the actual port and path from `<profile>/DevToolsActivePort`.
7. **Node 22+ has a global `WebSocket`,** so a CDP client needs no dependencies.

**Trade-off:** the CDP bridge uses its own Chrome window and profile, not your everyday browser. Driving your
normal Chrome would need a browser extension: a main-world content script at `document_start`, connected to
the bridge through the extension's service worker.

## 5. Pattern: a chat page driven by an agent

The page exposes chat tools, and the agent runs a loop:

1. `chat_wait_for_messages`: a long-poll. It returns unread messages immediately, or waits up to `timeout_seconds`.
2. Do the work, using the page's tools and Claude Code's own tools.
3. `chat_send_message`: posts the reply (Markdown).
4. Go back to 1.

Supporting pieces:
- `chat_set_status`: a "Thinking…" indicator in the page.
- A slash command (`.claude/commands/webmcp-chat.md`) holds the loop instructions, so `/webmcp-chat` starts it.
- The page shows presence (listening / connected / no agent) and an activity log of tool calls.
- Messages sent while no agent is connected stay queued (unread) and are delivered on the next connect.

## 6. Token cost

- **A pending tool call costs 0 tokens.** The model isn't running while `chat_wait_for_messages` waits.
  Tokens are spent only when a call returns and Claude takes a turn.
- **Each user message costs about 2 extra turns** compared with chatting in the terminal: one to read the
  message and work, one for `chat_send_message`. Each turn re-reads the conversation (mostly from the prompt
  cache, at about 10% of the normal input price).
- **Idle polling was the biggest waste.** With a 50s timeout, an idle hour meant about 72 turns.
  Fixes in place:
  - The default wait is 300s, so an idle hour is about 12 turns.
  - The page returns `idle_seconds` on an empty poll. After 600s, the agent posts a pause message and stops,
    so idle cost drops to zero. Run `/webmcp-chat` again to resume.
- **Let the page track idle time.** Having the agent count empty polls itself is unreliable.
- Further option, not done: raise the max wait to 1800s.

## 7. Claude Code behavior worth knowing

- **"Calling webmcp N times"**: Claude Code groups consecutive calls to the same MCP server into one line.
  `webmcp` is the server name from `.mcp.json`. The line stays on screen during a long-poll, which is normal.
- **The "↓ tokens" counter** shows tokens generated this turn. It doesn't grow while a tool call is pending.
- **Project MCP servers** in `.mcp.json` need a one-time approval when `claude` starts in that directory.
- **Approval prompts:** allow `mcp__webmcp` in `/permissions` to avoid one on every poll.
- **Headless testing:** `claude -p ... --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__webmcp`.
  In `-p` mode, tools that aren't allowed are denied rather than prompted.

## 8. How we tested

1. **Bridge test** (`scratchpad/bridge-test.mjs`): speaks MCP JSON-RPC over stdio to the bridge, with a
   throwaway Chrome profile (`WEBMCP_PROFILE_DIR`). A second CDP connection plays the user, typing into the
   page and submitting it.
2. **End-to-end:** a headless `claude -p` session opened the page through the bridge, read a queued message,
   ran `ls`, called the page's `add_todos`, and replied with `chat_send_message`.
3. **Spec surface:** from inside the page, `getTools()` returned all 10 tools, `executeTool()` returned a
   string, and the `navigator` alias pointed at the same object.

Not yet verified:
- Against Chrome's native WebMCP (origin trial / flag). The tests ran on the interceptor's stand-in.
- The full 10-minute idle stop in a live session.

## Sources

- [WebMCP spec (W3C CG draft)](https://webmachinelearning.github.io/webmcp/)
- [WebMCP in 2026: The API Moved and Most Guides Are Wrong](https://mcpplaygroundonline.com/blog/what-is-webmcp)
- [WebMCP's Origin Trial: provideContext Is Already Gone](https://jangwook.net/en/tags/ai-agent/)
