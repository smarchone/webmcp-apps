# Maps

A map of India that a Claude Code session draws on. Claude does the analysis with its own tools (files,
scripts, the web, other MCP servers), writes the results to files, and plots them as heatmaps, dots or
choropleths on states, districts and sub-districts. Layers persist, so later sessions keep adding to the
same map.

## Run

```bash
cd maps
npm start                         # map + data in ./workspace
npm start -- /path/to/folder      # or keep the map's data somewhere else
```

Open http://127.0.0.1:3459 in any browser. In another terminal, start `claude` in `maps/` and ask:

```
> /map pothole complaints in Bengaluru from this CSV, by sub-district
```

## How it works

```
claude ── analysis ──► workspace/potholes.csv
   └──── plot_points("potholes.csv") ──WebMCP──► page ──► server reads the file, places each point
                                                           in its state / district / sub-district
```

- **Data goes through files, not tool calls.** Claude writes CSV, GeoJSON or JSON Lines into the workspace
  and passes the path. A 10,000-row file costs the same tokens as a 10-row one.
- **Points:** `lat`,`lng`, or a `region` name/id (drawn at the region's centre). An `id` column dedupes rows
  across appended batches. `weight`, `label`, `date`, `category`, `url` are optional.
- **Region values:** a region column (`district`, `state` or `region`) plus a numeric column.
  Names are matched fuzzily, including old names (Bangalore, Gurgaon, Orissa). Ambiguous names (two
  Aurangabads) are reported back so Claude can add a `state` column.
- **Adding later:** plotting a new file with an existing `layer_id` appends it. Editing a file a layer uses
  updates every open tab.
- **Export:** `export_image` (or the Export button) saves a PNG with title, legend and attribution to
  `workspace/exports/`. Formats: `square` 1080×1080, `wide` 1600×900, `portrait` 1080×1350.

## Using the map

- Click a region to drill down: India → state → district → sub-district. The breadcrumb goes back up.
- The panel shows the focused region's numbers for each layer, and its top sub-regions.
- Search finds any state, district or taluk.
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

From India's [Local Government Directory](https://lgdirectory.gov.in/) (2024), via
[Bharatlas](https://bharatlas.com) (CC0): 36 states and UTs, 784 districts, 6,471 sub-districts, keyed by
LGD codes (`in:district:525` is Bengaluru Urban). Every map and export says where the boundaries come from
and that they are indicative.

They are simplified and stored in `data/india/` (32 MB). To rebuild them (downloads ~400 MB once):

```bash
npm install && npm run build:boundaries
```
