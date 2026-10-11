---
description: Analyse data and plot it on the map (countries and states worldwide, India's districts and sub-districts)
argument-hint: "[what to analyse and map]"
---

Analyse what the user asks for and plot it on the Maps page, using the `webmcp` MCP server's tools.

Request: $ARGUMENTS

1. Open `https://smarchone.github.io/webmcp-apps/maps/` with `browser_open_page`. If that fails (offline),
   ask the user to run `npm start` in `maps/` and open `http://127.0.0.1:3459` instead. If several tabs
   expose tools, pass this tab's id to `page_call_tool`.
2. Call `page_call_tool` → `get_map`. It lists the layers already on the map, the file formats and the workflow.
   Follow it.
3. Pass data as `rows: {"$file": "workspace/<path>"}` (the bridge sends the file's text to the page) plus its
   path as `file`, e.g. `{"rows": {"$file": "workspace/education/2026-10-07-iits.csv"}, "file": "education/2026-10-07-iits.csv", ...}`.
