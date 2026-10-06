---
description: Play the WebMCP dino game in the browser
argument-hint: "[number of games, default 3]"
---

Play the dino runner through its WebMCP tools, using the `webmcp` MCP server.

Setup:
1. Open `http://127.0.0.1:3457` with `browser_open_page`.
2. Call `page_call_tool` → `get_game_rules` once. Study the physics before playing.

Play $ARGUMENTS games (3 if no number was given). For each game:
1. `page_call_tool` → `start_game`. It returns the first obstacle the game froze on.
2. For every frozen state, call `page_call_tool` → `act` with `action`, `trigger_gap_px` and a `reason` of at
   most 6 words. `act` returns the next frozen state or `game_over`.
   - Work out the trigger from the physics. A jump clears an obstacle when the dino bottom `y(t)` stays above
     `altitude_px + height_px` for the whole overlap of `width_px + 44` px at the current speed. Aim for the
     middle of the valid window, not the edge.
   - Birds: `low` must be jumped, `mid` can be ducked under, `high` passes over a standing dino (use `none`;
     jumping into it is fatal).
   - Look at `other_obstacles`. If the next one is close, make sure you'll have landed before you need to jump
     again.
   - Use `recent_results` and the `dino` state to check your plans are working.
3. On `game_over`, read `cause_of_death`, work out what went wrong, and adjust your approach for the next game.

Keep thinking short between moves. Every `act` call is one turn, so don't narrate each move in the terminal.
At the end, print one short summary: the score of each game, the best score, and what you changed between games.
