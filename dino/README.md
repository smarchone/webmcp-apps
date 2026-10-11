# WebMCP Dino

A Chrome-style dino runner that Claude Code plays through WebMCP. Humans can play it too.

Play it in the browser: **https://smarchone.github.io/webmcp-apps/dino/**

## Run

The game is a static page published on GitHub Pages from [`docs/dino/`](../docs/dino/), so there's no
server to start.

Without a clone, add the bridge from npm once and ask Claude to play (the game page shows the same commands
with copy buttons):

```bash
claude mcp add -s user webmcp -- npx -y @smarchone/webmcp-bridge
claude "Open https://smarchone.github.io/webmcp-apps/dino/ with the webmcp tools and play one game"
```

From a clone, start `claude` in `dino/`, approve the `webmcp` server, then run:

```
/play-dino       # 1 game; /play-dino 3 for three
```

Claude opens the GitHub Pages URL in Chrome through the bridge and plays it there.

To play offline, `npm start` serves the same files at http://127.0.0.1:3457.

The bridge is shared by every app (`../bridge/webmcp-bridge.mjs`), so it uses the same Chrome window.

## How an agent plays a real-time game

Claude takes seconds per decision, but obstacles arrive every second or so. So in agent mode:

1. The game **freezes** when an obstacle comes into range and returns its size, gap and the current speed.
2. Claude calls `act` with a **plan**: `jump`, `duck` or `none`, plus `trigger_gap_px`, the gap at which to act.
3. The game resumes and runs the plan **in real time**, then freezes at the next obstacle.

Getting the timing right is real work. Claude gets the exact physics from `get_game_rules`
(`y(t) = 780t − 1300t²`, hitboxes, speeds) and has to work out a jump window that keeps it above the
obstacle for the whole overlap. The window moves as the game speeds up. `get_game_rules` also carries the
playing strategy and the score-1000 stop, so any MCP client can play well without a slash command.

## WebMCP tools (`document.modelContext`)

| Tool             | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `get_game_rules` | Physics, hitboxes, obstacle sizes, control rules, strategy, when to stop |
| `start_game`     | New game in agent mode; returns the first frozen state              |
| `act`            | Plan for the current obstacle; returns the next frozen state or `game_over` |
| `get_state`      | Current state, read-only                                             |
| `get_history`    | Past scores and causes of death                                     |

## Cost

- One `act` = one Claude turn, which is about one obstacle.
- A score of 1000 is about 40 obstacles.
- Claude stops each game at a score of 1000, as `get_game_rules` tells it to.
