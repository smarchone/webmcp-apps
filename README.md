# webmcp-apps

**Connect Claude Code to your frontend app. No backend. No API keys. No agent SDK.**

> Let your local Claude Code interact with any WebMCP compatible frontend app.

> or just Build rich agentic experiences using WebMCP and local Claude Code.

A testing ground for building rich interfaces that a local Claude Code session drives through
[WebMCP](https://webmachinelearning.github.io/webmcp/). Each page registers tools with
`document.modelContext.registerTool(...)`, and Claude calls them. See the [project page](https://smarchone.github.io/webmcp-apps).

```
claude ──MCP──► webmcp-bridge ──CDP──► Chrome tab ──► document.modelContext tools
```

![Markdown editor with Claude's replies in comment threads](docs/editor-example.png)

**Editor.** Highlight text, leave a comment, and Claude edits the doc and replies in the thread. Every change is versioned.

![Map of India with premium institutes plotted as dots](docs/maps-example.png)

**Maps.** Ask `/map plot IITs, NITs and other premium institutes in India`, and Claude researches, builds the layer and plots it across states and districts.

## Why it's worth a look

- **Any page becomes an agent surface.** Add a few tools and Claude Code can read state and take actions. You
  don't need a chat widget or a server.
- **You keep the full agent.** The session that runs your page still has files, shell and every other MCP
  server.
- **Small and dependency-free.** Plain HTML/JS plus one Node bridge. Fork it and add an app in minutes.

## The apps

| App                  | What Claude does                                                             | Port |
| -------------------- | ---------------------------------------------------------------------------- | ---- |
| [`chat/`](chat/)     | Acts as the assistant of a chat page, and manages its todos, notes and theme | 3456 |
| [`dino/`](dino/)     | Plays a dino runner from the game's physics, and learns from each death ([live](https://smarchone.github.io/webmcp-apps/dino/)) | Pages |
| [`editor/`](editor/) | Edits Markdown docs with you and answers your comment threads, with versions | 3458 |
| [`maps/`](maps/)     | Analyses data and plots it on India's states, districts and sub-districts ([live](https://smarchone.github.io/webmcp-apps/maps/)) | Pages |

All four share one MCP server, [`bridge/`](bridge/), which their `.mcp.json` files point at.

## Try it (1 minute, no clone)

Requires Node 22+ and Chrome. In any folder, add the bridge to Claude Code, then ask Claude to play:

```bash
claude mcp add webmcp -- npx -y @smarchone/webmcp-bridge
claude "Open https://smarchone.github.io/webmcp-apps/dino/ with the webmcp tools and play one game"
```

Chrome opens the [GitHub Pages copy of the game](https://smarchone.github.io/webmcp-apps/dino/) and Claude
starts playing. The game's own `get_game_rules` tool teaches Claude the physics and strategy, so no slash
command is needed. The [live maps app](https://smarchone.github.io/webmcp-apps/maps/) works the same way, and
its `get_map` tool carries the workflow:

```bash
claude "Open https://smarchone.github.io/webmcp-apps/maps/ with the webmcp tools and plot the IITs in India"
```

Both pages show these commands behind their "✳ Claude Code" button.

### From a clone

```bash
git clone https://github.com/smarchone/webmcp-apps
cd webmcp-apps/dino
claude                    # approve the webmcp server
> /play-dino
```

Maps works the same way from `maps/`. The other apps need their server first (`npm start` in the app's
folder), then run `claude` there and use its command:

| App       | Command                                  |
| --------- | ---------------------------------------- |
| `chat/`   | `/webmcp-chat`                           |
| `editor/` | `/review-docs` or `/address-comments`    |
| `maps/`   | `/map <what to analyse>`                 |

## Build your own

1. Copy an app folder. Keep `.mcp.json`, which points at the shared bridge in `bridge/`.
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

More detail: [`bridge/README.md`](bridge/README.md) covers the bridge, and
[`docs/webmcp-learnings.md`](docs/webmcp-learnings.md) has the API gotchas we hit.
