// WebMCP tools for the map. An agent connected to this page (e.g. Claude Code through the WebMCP bridge) does
// its analysis with its own tools, writes the results to files, and plots them with these. The page can't read
// files: the bridge replaces a {"$file": "path"} argument with the file's text, so rows arrive in the call.

const FILE_GUIDE = {
  where:
    'Write data files under workspace/ in the folder Claude Code runs in, then pass rows: {"$file": "workspace/<path>"} (the bridge inlines the file) and file: "<path>" (names the file in the layer, the table and error messages; its extension picks the format).',
  formats: '.csv, .tsv, .json (array of objects), .geojson (Point features) or .jsonl',
  points: {
    location: 'Either "lat" + "lng" columns (decimal degrees), or a "region" column (a region id like "in:district:525", or a name like "Bengaluru Urban"; add a "state" column when names repeat across states). Region-only rows are drawn at the region centre.',
    optional: '"id" (dedupes rows across appended files, e.g. tweet id), "weight" (default 1, or name another column with weight_field), "label", "date", "category" (colours dots), "url". Other columns show in the point popup.',
  },
  regions: {
    columns: 'A region column ("region", or the level name such as "district") with an id, LGD code or name, an optional "state" column for disambiguation, and a numeric column (named "value", or pass value_field).',
  },
  adding_later:
    'To add data in a later session, write a new file and call plot_points / plot_regions with the same layer_id: files are appended to the layer. The map does not watch files: after editing a file a layer uses, plot it again with the same layer_id and file to update it.',
  saved: 'Layers are saved in this browser (title and settings in localStorage, rows in IndexedDB). If they are gone, plot the files again.',
};

const ROWS = {
  description:
    'The data: {"$file": "workspace/<path>"} so the bridge passes the file\'s text (CSV, TSV, JSON, GeoJSON or JSON Lines), or an array of row objects for a few rows',
};
const FILE = {
  type: 'string',
  description: 'The file\'s name or path, e.g. "complaints/potholes-2026-10.csv". Labels the rows; plotting the same file to the same layer again replaces its rows',
};

function plotError(err) {
  if (!err.details) return err;
  return new Error(`${err.message}. ${JSON.stringify(err.details)}`);
}

function layerSummary(l) {
  return {
    layer_id: l.id,
    title: l.title,
    type: l.type,
    ...(l.level ? { level: l.level, value_field: l.value_field } : {}),
    style: l.style?.mode,
    visible: l.visible,
    files: l.files,
    plotted: l.stats?.plotted ?? null,
    ...(l.description ? { description: l.description } : {}),
    ...(l.source ? { source: l.source } : {}),
    updated_at: l.updated_at,
  };
}

export function buildTools({ store, regions, getFocus, setFocus, exportImage }) {
  return [
    {
      name: 'get_map',
      description:
        "Start here. Returns the map's title, its existing data layers (from earlier sessions too), the region the map is focused on, and how to pass data files to the plot tools.",
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const s = store.state();
        return {
          title: s.title,
          subtitle: s.subtitle,
          focus: getFocus(),
          layers: s.layers.map(layerSummary),
          hierarchy: 'country "in" > state "in:state:<LGD code>" > district "in:district:<code>" > subdistrict "in:subdistrict:<code>"',
          boundaries: s.boundaries,
          files: FILE_GUIDE,
        };
      },
    },
    {
      name: 'find_region',
      description:
        'Look up regions by name (fuzzy; old names like Bangalore, Gurgaon or Orissa work). Returns ids, levels, the parent chain, label point and bounding box. Use the id in data files when a name is ambiguous.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          level: { type: 'string', enum: ['state', 'district', 'subdistrict'] },
          within: { type: 'string', description: 'Region id or name to search inside, e.g. "in:state:29" or "Karnataka"' },
          limit: { type: 'number', description: 'Default 5' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
      execute: async (a) => ({ matches: regions.find(a.query, { level: a.level, within: a.within, limit: Number(a.limit) || 5 }) }),
    },
    {
      name: 'list_regions',
      description: 'List the regions inside a region (default: the states of India). Pass level to skip down, e.g. all sub-districts of a state.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { type: 'string', description: 'Default "in" (India)' },
          level: { type: 'string', enum: ['state', 'district', 'subdistrict'] },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (a) => {
        const parent = a.parent_id || 'in';
        if (!regions.get(parent)) throw new Error(`Unknown region: ${parent}`);
        return { parent, regions: regions.children(parent, a.level) };
      },
    },
    {
      name: 'plot_points',
      description:
        'Plot points from a data file as a heatmap or dots. Pass rows: {"$file": "workspace/<path>"} plus file. Creates a layer, or appends the file to an existing layer when layer_id matches one (use this to add data incrementally). Returns rows plotted, skipped rows with reasons, and the top states. See get_map for the file format.',
      inputSchema: {
        type: 'object',
        properties: {
          rows: ROWS,
          file: FILE,
          title: { type: 'string', description: 'Layer name shown on the map and in the legend. Required for a new layer; ignored when appending' },
          layer_id: { type: 'string', description: 'Existing layer to append to, or the id for a new layer' },
          replace: { type: 'boolean', description: 'Replace the layer\'s files with this one instead of appending' },
          style: { type: 'string', enum: ['heatmap', 'dots'], description: 'Default: heatmap for 200+ points, dots otherwise. Dots are sized by weight' },
          weight_field: { type: 'string', description: 'Column to weight points by (heat intensity, dot size), e.g. "population". Default: a "weight" or "count" column, else 1' },
          color: { type: 'string', description: 'Dot colour when there is no category column, e.g. "#3b82c4"' },
          description: { type: 'string', description: 'One line on what the layer shows and how it was derived' },
          source: { type: 'string', description: 'Where the data came from, shown as attribution, e.g. "X posts, 1–7 Oct 2026"' },
        },
        required: ['rows'],
      },
      execute: async (a) =>
        store.plot({
          type: 'points',
          id: a.layer_id,
          rows: a.rows,
          file: a.file,
          title: a.title,
          append: !a.replace,
          weight_field: a.weight_field,
          style: { mode: a.style, color: a.color },
          description: a.description,
          source: a.source,
        }).catch((err) => {
          throw plotError(err);
        }),
    },
    {
      name: 'plot_regions',
      description:
        'Colour regions by a value from a data file (choropleth), at state, district or sub-district level. Pass rows: {"$file": "workspace/<path>"} plus file. Appends to an existing layer when layer_id matches. Returns matched regions, unmatched names with reasons, and the highest and lowest values.',
      inputSchema: {
        type: 'object',
        properties: {
          rows: ROWS,
          file: FILE,
          level: { type: 'string', enum: ['state', 'district', 'subdistrict'] },
          title: { type: 'string', description: 'Required for a new layer; ignored when appending' },
          value_field: { type: 'string', description: 'Numeric column to colour by. Default: a "value" column, or the only numeric column' },
          layer_id: { type: 'string' },
          replace: { type: 'boolean' },
          palette: { type: 'string', enum: ['oranges', 'reds', 'blues', 'greens', 'purples', 'viridis'] },
          reverse: { type: 'boolean', description: 'Darkest colour for the lowest values' },
          aggregate: {
            type: 'string',
            enum: ['sum', 'mean', 'none'],
            description: 'How to roll values up to bigger regions in the panel: "sum" for counts, "mean" for rates, "none" (default) shows the highest',
          },
          description: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['rows', 'level'],
      },
      execute: async (a) =>
        store.plot({
          type: 'regions',
          id: a.layer_id,
          rows: a.rows,
          file: a.file,
          level: a.level,
          title: a.title,
          value_field: a.value_field,
          append: !a.replace,
          style: { mode: 'choropleth', palette: a.palette, reverse: a.reverse },
          aggregate: a.aggregate,
          description: a.description,
          source: a.source,
        }).catch((err) => {
          throw plotError(err);
        }),
    },
    {
      name: 'update_layer',
      description: "Change a layer's title, description, source, visibility or style. Pass order (all layer ids, bottom first) to restack layers.",
      inputSchema: {
        type: 'object',
        properties: {
          layer_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          source: { type: 'string' },
          visible: { type: 'boolean' },
          style: { type: 'string', enum: ['heatmap', 'dots', 'choropleth'] },
          color: { type: 'string' },
          palette: { type: 'string', enum: ['oranges', 'reds', 'blues', 'greens', 'purples', 'viridis'] },
          radius: { type: 'number', description: 'Heatmap radius multiplier, default 1' },
          opacity: { type: 'number' },
          order: { type: 'array', items: { type: 'string' } },
        },
        required: ['layer_id'],
      },
      execute: async (a) =>
        store.update({
          id: a.layer_id,
          title: a.title,
          description: a.description,
          source: a.source,
          visible: a.visible,
          order: a.order,
          style: { mode: a.style, color: a.color, palette: a.palette, radius: a.radius, opacity: a.opacity },
        }),
    },
    {
      name: 'remove_layer',
      description: 'Remove a layer from the map. Its data files stay where they are.',
      inputSchema: { type: 'object', properties: { layer_id: { type: 'string' } }, required: ['layer_id'] },
      annotations: { destructiveHint: true },
      execute: async (a) => store.remove(a.layer_id),
    },
    {
      name: 'summarize_layer',
      description:
        'Totals of a layer by region, as plotted: point counts (or values) grouped by state, district or sub-district, optionally inside one region. Use it to check the plot and to find patterns worth pointing out.',
      inputSchema: {
        type: 'object',
        properties: {
          layer_id: { type: 'string' },
          within: { type: 'string', description: 'Region id or name, default India' },
          by: { type: 'string', enum: ['state', 'district', 'subdistrict'], description: 'Default: one level below "within"' },
          limit: { type: 'number', description: 'Default 15' },
        },
        required: ['layer_id'],
      },
      annotations: { readOnlyHint: true },
      execute: async (a) => store.summarize(a.layer_id, { within: a.within, by: a.by, limit: Number(a.limit) || 15 }),
    },
    {
      name: 'show_region',
      description: 'Zoom every open map tab to a region (drill down or up the hierarchy). Accepts a region id or a name; "India" goes back to the whole country.',
      inputSchema: { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] },
      execute: async (a) => {
        let id = a.region;
        if (/^india$/i.test(id.trim())) id = 'in';
        if (!/^in(:|$)/.test(id)) {
          const [match] = regions.find(a.region, { limit: 1 });
          if (!match) throw new Error(`No region matches "${a.region}"`);
          id = match.id;
        }
        if (!regions.get(id)) throw new Error(`Unknown region: ${id}`);
        store.broadcastView(id);
        await setFocus(id);
        return { focus: id };
      },
    },
    {
      name: 'set_title',
      description: 'Set the map headline and subtitle, shown on the page and on exported images. Keep the title to the finding, e.g. "Pothole complaints cluster in Bengaluru\'s east".',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } } },
      execute: async (a) => store.setTitle(a),
    },
    {
      name: 'export_image',
      description:
        "Save the current map view as a PNG with title, legend and data/boundary attribution. The browser downloads it (to its downloads folder) and the result gives the file name. Formats: current (as on screen), square (1080×1080, Instagram), wide (1600×900, X/Twitter), portrait (1080×1350).",
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['current', 'square', 'wide', 'portrait'] },
          region: { type: 'string', description: 'Region id to frame first (optional)' },
          title: { type: 'string', description: 'Override the map title for this image' },
          subtitle: { type: 'string' },
        },
      },
      execute: async (a) => {
        if (a.region) {
          if (!regions.get(a.region)) throw new Error(`Unknown region: ${a.region}`);
          store.broadcastView(a.region);
          await setFocus(a.region, { fly: false });
        }
        const out = await exportImage({ format: a.format || 'current', title: a.title, subtitle: a.subtitle });
        return { file: out.file, saved_to: "the browser's downloads folder", width: out.width, height: out.height, format: out.format };
      },
    },
  ];
}

// Agents sometimes guess argument names; reject unknown ones instead of silently ignoring them
function checked(tool) {
  const props = tool.inputSchema.properties || {};
  return {
    ...tool,
    execute: async (input = {}, opts) => {
      const unknown = Object.keys(input).filter((k) => !(k in props));
      if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}. Valid: ${Object.keys(props).join(', ')}`);
      const missing = (tool.inputSchema.required || []).filter((k) => input[k] == null || input[k] === '');
      if (missing.length) throw new Error(`Missing argument(s): ${missing.join(', ')}`);
      return tool.execute(input, opts);
    },
  };
}

export async function registerTools(ctx) {
  if (!('modelContext' in document)) return { ok: false, count: 0 };
  const tools = buildTools(ctx).map(checked);
  await Promise.all(tools.map((t) => document.modelContext.registerTool(t)));
  return { ok: true, count: tools.length };
}
