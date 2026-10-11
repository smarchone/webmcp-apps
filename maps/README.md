# Maps

A world map that a Claude Code session draws on, with extra detail for India. Claude does the analysis with its
own tools (files, scripts, the web, other MCP servers), writes the results to files, and plots them as heatmaps,
dots or choropleths on countries and their states / provinces, and in India also on districts and sub-districts. Layers persist, so later sessions keep adding to the
same map.

The map is plain static files: no app server, no build step. The page lives in [`docs/maps/`](../docs/maps/),
so GitHub Pages publishes it at https://smarchone.github.io/webmcp-apps/maps/. This folder holds the `/map`
command, the `workspace/` your data files go in, and the boundary build script.

## Run

Without a clone, add the bridge from npm in any folder and ask Claude to map something (the map's
"Install for Claude Code" button shows the same commands with copy buttons):

```bash
claude mcp add webmcp -- npx -y @smarchone/webmcp-bridge
claude "Open https://smarchone.github.io/webmcp-apps/maps/ with the webmcp tools and plot the IITs in India"
```

Claude writes its data files under `workspace/` in that folder. The map's `get_map` tool carries the workflow
(reuse layers, set a source, headline the finding), so no slash command is needed.

From a clone, start `claude` in `maps/` and ask:

```
> /map pothole complaints in Bengaluru from this CSV, by sub-district
```

Chrome opens the hosted map and Claude starts working. To use the map offline, serve it locally with
`npm start` (`python3 -m http.server 3459` on `docs/maps/`) and open http://127.0.0.1:3459. Any other static
server works too: every URL the page loads is relative.

## How it works

```
claude ── analysis ──► workspace/potholes.csv
   └──── plot_points({ rows: {"$file": "workspace/potholes.csv"} }) ──► bridge inlines the file
                                                                        ──WebMCP──► page parses the rows and
                                                                        places each point in its country /
                                                                        state (/ district / sub-district)
```

- **Data goes through files, not the conversation.** Claude writes CSV, GeoJSON or JSON Lines into
  `workspace/` and passes `{"$file": "workspace/<path>"}`. The [bridge](../bridge/) replaces that with the
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

- **World:** [Natural Earth](https://www.naturalearthdata.com) v5.1.2 (public domain), from its India point of
  view: 245 countries and 4,558 states / provinces. Countries are keyed by lower-case ISO 3166 alpha-2 codes
  (`us`), states by ISO 3166-2 (`us:state:US-CA`).
- **India:** the [Local Government Directory](https://lgdirectory.gov.in/) (2024), via
  [Bharatlas](https://bharatlas.com) (CC0): 36 states and UTs, 784 districts, 6,471 sub-districts, keyed by
  LGD codes (`in:district:525` is Bengaluru Urban). India's outline comes from these files too, and the world
  boundaries are cut where they overlap it, so India's states sit exactly inside it.

Every map and export says where the boundaries come from and that they are indicative.

They are simplified and stored in `docs/maps/data/world/` (14 MB) and `docs/maps/data/india/` (32 MB). The page
loads the countries and India's states and districts at startup, and a country's states or an Indian state's
sub-districts when you first open them. A service worker (`docs/maps/sw.js`) keeps each file in the browser after
its first download, so repeat visits don't fetch them again. To rebuild them:

```bash
npm install
npm run build:boundaries   # India, downloads ~400 MB once
npm run build:world        # the world, downloads ~55 MB once; run it after build:boundaries
```
