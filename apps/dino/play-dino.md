---
description: Play the WebMCP dino game in the browser
argument-hint: "[number of games, default 1]"
---

Play the dino runner through its WebMCP tools, using the `webmcp` MCP server.

1. Open `https://smarchone.github.io/webmcp-apps/dino/` with `browser_open_page`. If that fails (offline),
   ask the user to serve `apps/` from a clone (`npx serve apps`) and open its `/dino/` page instead.
2. Call `page_call_tool` → `get_game_rules` once. It has the physics, the controls, a strategy and when to stop
   a game. Follow it.
3. Play $ARGUMENTS games (1 if no number was given) with `start_game` and `act`.
