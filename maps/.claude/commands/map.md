---
description: Analyse data and plot it on the India map (states, districts, sub-districts)
argument-hint: "[what to analyse and map]"
---

Analyse what the user asks for and plot it on the Maps page, using the `webmcp` MCP server's tools.

Request: $ARGUMENTS

1. Open `http://127.0.0.1:3459` with `browser_open_page`. If several tabs expose tools, pass this tab's id to
   `page_call_tool`.
2. Call `page_call_tool` → `get_map`. It lists the layers already on the map (from earlier sessions), the
   workspace folder, and the file formats. If a layer already covers this topic, add to it instead of making a
   new one.
3. Do the analysis with your own tools (files, scripts, web, other MCP servers). Keep raw data out of tool calls:
   write the result to a file in the workspace, e.g. `<topic>/<yyyy-mm-dd>-<what>.csv`.
   - Points: `lat`,`lng` when you know the spot; otherwise a `region` column (a name or an id from
     `find_region`) plus `state` when names repeat. Add an `id` column (e.g. post id) so appended batches
     dedupe, and `label`, `date`, `category`, `url` where you have them.
   - Region values: a `region` (or `district` / `state`) column plus a numeric column. Use rates (per lakh
     people, per km of road) when comparing regions of different sizes.
4. Plot with `plot_points` or `plot_regions`. Always set `source` (where the data came from and its date
   range) and a one-line `description` of how you derived it. To add to an existing layer, pass its
   `layer_id`.
5. Read the result: fix rows it skipped (unknown or ambiguous names) and plot again with `replace: true`.
   Use `summarize_layer` to check the numbers and find the pattern worth telling.
6. Set a headline with `set_title`: the finding, not the topic. Zoom to where the story is with `show_region`.
7. If the user asked for an image, call `export_image` (`square` for Instagram, `wide` for X).

Finish in the terminal with 2–4 lines: what you plotted, the main pattern, and the layer id for adding more
later. Don't present guesses as data. Say where coverage is thin.
