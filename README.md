# webmcp-apps

**Let your local Claude Code drive a web page. No backend, no API keys, no agent SDK.**

Each page registers tools with [WebMCP](https://webmachinelearning.github.io/webmcp/)
(`document.modelContext.registerTool(...)`), and Claude Code calls them through a small bridge.

```
claude ──MCP──► webmcp-bridge ──CDP──► Chrome tab ──► document.modelContext tools
```

## Quick start

You need Node 22+, Chrome and [Claude Code](https://claude.com/claude-code). In the folder you run
`claude` from, add the bridge once:

```bash
claude mcp add webmcp -- npx -y @smarchone/webmcp-bridge
```

Then ask Claude to open one of the live apps:

```bash
claude "Open https://smarchone.github.io/webmcp-apps/dino/ with the webmcp tools and play one game"
claude "Open https://smarchone.github.io/webmcp-apps/maps/ with the webmcp tools and plot the IITs in India"
```

Chrome opens the page and Claude starts using its tools. Each page teaches Claude what to do through
its own tools, so there's nothing else to install.

## The apps

| App                  | What Claude does                                                         | Run it                                                     |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [`dino/`](dino/)     | Plays a dino runner from the game's physics and learns from each death   | [Live](https://smarchone.github.io/webmcp-apps/dino/)      |
| [`maps/`](maps/)     | Analyses data and plots it on the world's countries and states, and India's districts and sub-districts | [Live](https://smarchone.github.io/webmcp-apps/maps/)      |
| [`editor/`](editor/) | Edits Markdown docs with you and answers your comment threads            | From a clone                                               |
| [`chat/`](chat/)     | Acts as a chat page's assistant and manages its todos, notes and theme   | From a clone                                               |

![Markdown editor with Claude's replies in comment threads](docs/editor-example.png)

## From a clone

```bash
git clone https://github.com/smarchone/webmcp-apps
cd webmcp-apps/<app>
npm start        # editor and chat only: starts the page's local server
claude           # approve the webmcp server when asked
```

Then use the app's slash command:

| App       | Command                               |
| --------- | ------------------------------------- |
| `dino/`   | `/play-dino`                          |
| `maps/`   | `/map <what to analyse>`              |
| `editor/` | `/review-docs` or `/address-comments` |
| `chat/`   | `/webmcp-chat`                        |

## Build your own

1. Copy an app folder. Its `.mcp.json` already points at the shared bridge in [`bridge/`](bridge/).
2. Register tools on your page:

   ```js
   await document.modelContext.registerTool({
     name: 'do_thing',
     description: 'What the agent can do here',
     inputSchema: { type: 'object', properties: {} },
     async execute(input) { return { ok: true }; },
   });
   ```

3. Add a slash command in `.claude/commands/` that tells Claude how to use them.

[`bridge/README.md`](bridge/README.md) covers the bridge, and
[`docs/webmcp-learnings.md`](docs/webmcp-learnings.md) has the API gotchas we hit.
