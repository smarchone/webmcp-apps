# Maps

A world map that a Claude Code session draws on, with extra detail for India. Claude does the analysis with its
own tools (files, scripts, the web, other MCP servers), writes the results to files, and plots them as heatmaps,
dots or choropleths on countries and their states / provinces, and in India also on districts and sub-districts.
Layers persist, so later sessions keep adding to the same map.

Open it at **https://smarchone.github.io/webmcp-apps/maps/**. Its "Install for Claude Code" button has the install
commands, and its Advanced section has a detailed prompt and the [`/map`](map.md) command. Claude writes its data
files under `workspace/` in the folder it runs in.

## How it works

```
claude ── analysis ──► workspace/potholes.csv
   └──── plot_points({ rows: {"$file": "workspace/potholes.csv"} }) ──► bridge inlines the file
                                                                        ──WebMCP──► page parses the rows and
                                                                        places each point in its country /
                                                                        state (/ district / sub-district)
```

- **Data goes through files, not the conversation.** Claude writes CSV, GeoJSON or JSON Lines into
  `workspace/` and passes `{"$file": "workspace/<path>"}`. The [bridge](../../bridge/) replaces that with the
  file's text on the way to the page, so a 10,000-row file costs Claude the same tokens as a 10-row one.
- **Points:** `lat`,`lng`, or a `region` name/id (drawn at the region's centre). An `id` column dedupes rows
  across appended batches. `weight`, `label`, `date`, `category`, `url` are optional.
- **Region values:** a region column (`country`, `state`, `district` or `region`) plus a numeric column.
  Names are matched fuzzily, including old names (Bangalore, Gurgaon, Orissa) and ISO codes (`US`, `USA`,
  `US-CA`). Ambiguous names (two Aurangabads) are reported back so Claude can add a `state` column. When a name
  exists in India and elsewhere (Punjab), India's wins unless a `country` column says otherwise.
- **Adding later:** plotting a new file with an existing `layer_id` appends it. The map doesn't watch files:
  after editing one, Claude plots it again with the same `layer_id` and file name, which replaces that
  file's rows.
- **Saved in the browser:** the title and layer settings live in localStorage, the plotted rows in IndexedDB.
  Every open tab of the map redraws when they change. They belong to one browser profile (the bridge's own
  Chrome), so clearing its site data clears the map; the files are still in `workspace/`, and Claude can
  plot them again.
- **Export:** `export_image` (or the Export button) downloads a PNG with title, legend and attribution to the
  browser's downloads folder. Formats: `square` 1080×1080, `wide` 1600×900, `portrait` 1080×1350.

## Using the map

- Click a region to drill down: World → country → state / province, and in India on to district → sub-district.
  The breadcrumb goes back up.
- The panel shows the focused region's numbers for each layer, and its top sub-regions.
- Search finds any country, state, district or taluk.
- **▦ Table** shows each layer's rows for the region you're in: sort by any column, filter, download as CSV.
  Click a row to see it on the map. Drag the drawer's top edge to resize it.
- Drag the edge between the panel and the map to resize the panel (double-click resets it).
- Click a legend entry (a category, or a value range) to highlight only that one: the rest fade on the map,
  and the panel, table and exports count only the highlighted entry. Click it again to show everything.
- Heatmaps stay on at every zoom. Individual points fade in from state zoom and draw above region names.
- **◐ Auto / ☀ Light / ☾ Dark** in the panel header switches the theme (Auto follows your system).

## WebMCP tools on the page

`get_map`, `find_region`, `list_regions`, `plot_points`, `plot_regions`, `update_layer`, `remove_layer`,
`summarize_layer`, `show_region`, `set_title`, `export_image`

## Boundaries

World boundaries come from Natural Earth (public domain) and India's from the Local Government Directory via
Bharatlas (CC0). Every map and export says where they come from and that they are indicative. They live in
`data/`; [`scripts/maps/`](../../scripts/maps/) rebuilds them. The page loads the countries and India's states and
districts at startup, and a country's states or an Indian state's sub-districts when you first open them. A
service worker (`sw.js`) keeps each file in the browser after its first download.
