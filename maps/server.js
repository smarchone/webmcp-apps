// Maps server.
// Serves the map UI, India's admin boundaries, and the data layers Claude plots from files in the workspace.
// Layers are saved in <workspace>/.maps/state.json, so later sessions keep adding to the same map.
//
//   node server.js [workspace]      (default: ./workspace)
import http from 'node:http';
import fs from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RegionIndex } from './lib/regions.js';
import { parseFile } from './lib/parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3459;
const WORK = path.resolve(process.argv[2] || process.env.MAPS_WORKSPACE || path.join(HERE, 'workspace'));
const STATE_FILE = path.join(WORK, '.maps', 'state.json');
const EXPORTS = path.join(WORK, 'exports');
const APP_DIR = path.join(HERE, 'app');
const DATA_DIR = path.join(HERE, 'data');

const regions = new RegionIndex(path.join(DATA_DIR, 'india'));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- Workspace files ----------

function workspacePath(file) {
  if (typeof file !== 'string' || !file.trim()) throw httpError(400, 'file is required');
  const abs = path.resolve(WORK, file.trim());
  if (!abs.startsWith(WORK + path.sep)) throw httpError(400, `File must be inside the workspace: ${WORK}`);
  return { rel: path.relative(WORK, abs).split(path.sep).join('/'), abs };
}

// ---------- Map state ----------

let state = { title: '', subtitle: '', layers: [] };

async function loadState() {
  try {
    state = { ...state, ...JSON.parse(await readFile(STATE_FILE, 'utf8')) };
  } catch {}
}

async function saveState() {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  broadcast('state_changed', publicState());
}

const publicState = () => ({ ...state, workspace: WORK, boundaries: regions.source });
const findLayer = (id) => state.layers.find((l) => l.id === id);

function slug(s) {
  return String(s || 'layer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'layer';
}

// ---------- Layer data (parsed from files, cached by mtime) ----------

const cache = new Map(); // layer id -> { key, data }

async function layerData(layer) {
  const mtimes = await Promise.all(layer.files.map((f) => stat(workspacePath(f).abs).then((s) => s.mtimeMs, () => 0)));
  const key = JSON.stringify([layer.files, mtimes, layer.type, layer.level, layer.value_field, layer.weight_field]);
  const hit = cache.get(layer.id);
  if (hit?.key === key) return hit.data;

  const data = layer.type === 'points' ? await loadPoints(layer) : await loadRegionValues(layer);
  data.key = createHash('sha1').update(key).digest('hex').slice(0, 12);
  cache.set(layer.id, { key, data });
  return data;
}

async function loadPoints(layer) {
  const seen = new Set();
  const features = [];
  const skipped = [];
  let rows = 0;
  for (const file of layer.files) {
    const { abs } = workspacePath(file);
    let records;
    try {
      records = await parseFile(abs);
    } catch (err) {
      skipped.push({ file, reason: err.message });
      continue;
    }
    for (const r of records) {
      rows++;
      const p = normalizePoint(r, layer.weight_field);
      if (p.id != null) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
      }
      let coords = p.coords;
      let where;
      if (coords) {
        where = regions.locate(coords[0], coords[1]);
        if (!where.state) {
          skip(skipped, file, r.__line, `outside India (${coords[1]}, ${coords[0]})`);
          continue;
        }
      } else if (p.region) {
        const { region, error } = regions.resolve(p.region, { state: p.state });
        if (!region) {
          skip(skipped, file, r.__line, error);
          continue;
        }
        coords = region.label;
        where = regions.chain(region.id);
      } else {
        skip(skipped, file, r.__line, 'no lat/lng and no region');
        continue;
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords },
        properties: {
          ...p.props,
          _w: p.weight,
          _label: p.label,
          _date: p.date,
          _category: p.category,
          _url: p.url,
          _approx: !p.coords,
          _state: where.state || null,
          _district: where.district || null,
          _subdistrict: where.subdistrict || null,
        },
      });
    }
  }
  return {
    type: 'points',
    geojson: { type: 'FeatureCollection', features },
    stats: { rows, plotted: features.length, duplicates: rows - features.length - skippedRows(skipped), skipped: skipped.length },
    skipped,
  };
}

// Columns that name a region rather than measure it
const REGION_COLUMNS = new Set(['region', 'region_id', 'id', 'name', 'state', 'district', 'subdistrict', 'code', 'lgd', 'lgd_code', 'state_code', 'district_code']);

function detectValueField(records) {
  const sample = records.slice(0, 200);
  const cols = Object.keys(sample[0] || {}).filter((k) => k !== '__line' && !REGION_COLUMNS.has(k.toLowerCase().trim()));
  const numeric = cols.filter((k) => {
    const nums = sample.filter((r) => r[k] !== '' && r[k] != null && Number.isFinite(Number(String(r[k]).replace(/,/g, '')))).length;
    return nums >= Math.max(1, sample.length * 0.8);
  });
  return numeric.find((k) => k.toLowerCase() === 'value') || (numeric.length === 1 ? numeric[0] : null) || { candidates: numeric, columns: cols };
}

async function loadRegionValues(layer) {
  const values = {};
  const skipped = [];
  let rows = 0;
  let valueField = layer.value_field;
  let columns;
  for (const file of layer.files) {
    const { abs } = workspacePath(file);
    let records;
    try {
      records = await parseFile(abs);
    } catch (err) {
      skipped.push({ file, reason: err.message });
      continue;
    }
    if (!valueField) {
      const found = detectValueField(records);
      if (typeof found === 'string') valueField = found;
      else {
        columns = Object.keys(records[0] || {}).filter((k) => k !== '__line');
        const why = found.candidates.length ? `several numeric columns (${found.candidates.join(', ')})` : 'no numeric column';
        skipped.push({ file, reason: `${why}: pass value_field` });
        continue;
      }
    }
    for (const r of records) {
      rows++;
      const lower = lowerKeys(r);
      const ref = lower.region_id ?? lower.region ?? lower[layer.level] ?? lower.name ?? lower.id;
      if (ref == null || ref === '') {
        skip(skipped, file, r.__line, `no region column (use "region" or "${layer.level}")`);
        continue;
      }
      const { region: match, error } = regions.resolve(String(ref), { level: layer.level, state: layer.level === 'state' ? null : lower.state });
      if (!match) {
        skip(skipped, file, r.__line, error);
        continue;
      }
      const raw = lower[valueField.toLowerCase()];
      const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/,/g, ''));
      if (raw == null || raw === '' || !Number.isFinite(value)) {
        skip(skipped, file, r.__line, `"${valueField}" is not a number`);
        continue;
      }
      const props = {};
      for (const [k, v] of Object.entries(r)) if (k !== '__line') props[k] = v;
      values[match.id] = { value, name: match.name, props };
    }
  }
  const nums = Object.values(values).map((v) => v.value);
  return {
    type: 'regions',
    level: layer.level,
    value_field: valueField,
    ...(columns ? { columns } : {}),
    values,
    range: nums.length ? [Math.min(...nums), Math.max(...nums)] : null,
    stats: { rows, plotted: nums.length, skipped: skipped.length },
    skipped,
  };
}

function skip(list, file, line, reason) {
  list.push({ file, line, reason });
}
const skippedRows = (list) => list.filter((s) => s.line != null).length;

function lowerKeys(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k.toLowerCase().trim()] = v;
  return out;
}

const FIELD = {
  lat: ['lat', 'latitude', 'y'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x'],
  id: ['id', 'tweet_id', 'post_id', 'uid'],
  weight: ['weight', 'count', 'value', 'intensity'],
  label: ['label', 'title', 'name', 'summary'],
  date: ['date', 'time', 'timestamp', 'created_at', 'datetime'],
  category: ['category', 'type', 'kind', 'topic'],
  url: ['url', 'link', 'source_url'],
  region: ['region', 'region_id', 'place', 'location', 'district', 'city'],
  state: ['state'],
};

function pick(lower, names) {
  for (const n of names) if (lower[n] != null && lower[n] !== '') return lower[n];
  return null;
}

function normalizePoint(r, weightField) {
  // GeoJSON features arrive with __coords already set by the parser
  const lower = lowerKeys(r);
  let coords = r.__coords || null;
  if (!coords) {
    const lat = Number(pick(lower, FIELD.lat));
    const lng = Number(pick(lower, FIELD.lng));
    if (pick(lower, FIELD.lat) != null && Number.isFinite(lat) && Number.isFinite(lng)) coords = [lng, lat];
  }
  const w = Number(String(weightField ? lower[weightField.toLowerCase()] ?? '' : pick(lower, FIELD.weight) ?? '').replace(/,/g, ''));
  const props = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('__')) props[k] = v;
  const id = pick(lower, FIELD.id);
  return {
    coords,
    id: id == null ? null : String(id),
    weight: Number.isFinite(w) && w > 0 ? w : 1,
    label: pick(lower, FIELD.label),
    date: pick(lower, FIELD.date),
    category: pick(lower, FIELD.category),
    url: pick(lower, FIELD.url),
    region: lower.region_id ?? pick(lower, FIELD.region),
    state: lower.state ?? null,
    props,
  };
}

// ---------- Summaries ----------

const CHILD = { country: 'state', state: 'district', district: 'subdistrict' };

async function summarize(layer, { by, within, limit = 15 }) {
  const data = await layerData(layer);
  const scope = regions.get(within ? regions.resolveId(within) : 'in');
  if (!scope) throw httpError(404, `Unknown region: ${within}`);
  const level = by || CHILD[scope.level];
  if (!level) throw httpError(400, `Can't group a ${scope.level} into smaller regions`);

  if (data.type === 'points') {
    const groups = new Map();
    let total = 0, weight = 0, approx = 0;
    for (const f of data.geojson.features) {
      const p = f.properties;
      if (scope.level !== 'country' && p[`_${scope.level}`] !== scope.id) continue;
      total++;
      weight += p._w;
      const key = p[`_${level}`];
      if (!key) {
        approx++;
        continue;
      }
      const g = groups.get(key) || { count: 0, weight: 0 };
      g.count++;
      g.weight += p._w;
      groups.set(key, g);
    }
    const rows = [...groups].map(([id, g]) => ({ region_id: id, name: regions.get(id)?.name, count: g.count, weight: +g.weight.toFixed(3) }));
    rows.sort((a, b) => b.weight - a.weight);
    return {
      layer_id: layer.id,
      within: { id: scope.id, name: scope.name },
      by: level,
      total_points: total,
      total_weight: +weight.toFixed(3),
      ...(approx ? { not_placed_at_this_level: approx } : {}),
      regions_with_data: rows.length,
      top: rows.slice(0, limit),
    };
  }

  const rows = Object.entries(data.values)
    .filter(([id]) => scope.level === 'country' || regions.chain(id)[scope.level] === scope.id)
    .map(([id, v]) => ({ region_id: id, name: v.name, value: v.value }));
  rows.sort((a, b) => b.value - a.value);
  const sum = rows.reduce((s, r) => s + r.value, 0);
  return {
    layer_id: layer.id,
    within: { id: scope.id, name: scope.name },
    level: data.level,
    regions_with_data: rows.length,
    mean: rows.length ? +(sum / rows.length).toFixed(3) : null,
    highest: rows.slice(0, limit),
    lowest: rows.slice(-Math.min(5, rows.length)).reverse(),
  };
}

// ---------- Layer API ----------

const STYLES = { points: ['heatmap', 'dots'], regions: ['choropleth'] };

async function upsertLayer(body) {
  const type = body.type === 'regions' ? 'regions' : 'points';
  const { rel } = workspacePath(body.file);
  if (!fs.existsSync(path.join(WORK, rel))) throw httpError(404, `File not found in workspace: ${rel}`);

  const existing = body.id ? findLayer(body.id) : null;
  const now = new Date().toISOString();
  let layer;
  if (existing) {
    delete body.title; // appending keeps the layer's name; rename with update_layer
    if (existing.type !== type) throw httpError(409, `Layer "${existing.id}" holds ${existing.type}, not ${type}`);
    layer = structuredClone(existing);
    if (body.append === false) layer.files = [rel];
    else if (!layer.files.includes(rel)) layer.files.push(rel);
  } else {
    if (!body.title?.trim()) throw httpError(400, 'title is required for a new layer');
    if (type === 'regions' && !['state', 'district', 'subdistrict'].includes(body.level)) {
      throw httpError(400, 'level must be state, district or subdistrict');
    }
    let id = slug(body.id || body.title);
    while (findLayer(id)) id = `${id}-2`;
    layer = {
      id,
      title: body.title.trim(),
      type,
      level: type === 'regions' ? body.level : undefined,
      files: [rel],
      style: {},
      visible: true,
      created_at: now,
    };
  }
  applyLayerFields(layer, body);
  layer.updated_at = now;

  // Check the data before changing the map: a file with nothing plottable doesn't create or break a layer
  cache.delete(layer.id);
  const data = await layerData(layer);
  if (!data.stats.plotted) {
    cache.delete(layer.id);
    const err = httpError(422, `Nothing in ${rel} could be plotted, so the map was not changed`);
    err.details = { rows: data.stats.rows, skipped_examples: data.skipped.slice(0, 8), ...(data.columns ? { columns: data.columns } : {}) };
    throw err;
  }
  layer.stats = data.stats;
  // A heatmap of a handful of points is a few faint blobs: default small layers to dots
  const askedMode = typeof body.style === 'string' ? body.style : body.style?.mode;
  if (!existing && type === 'points' && !askedMode) layer.style.mode = data.stats.plotted >= 200 ? 'heatmap' : 'dots';
  if (existing) Object.assign(existing, layer);
  else state.layers.push(layer);
  layer = existing || layer;
  await saveState();
  broadcast('layer_data_changed', { id: layer.id, by: 'claude', file: rel, stats: data.stats, key: data.key });

  const result = {
    layer_id: layer.id,
    title: layer.title,
    files: layer.files,
    ...(data.value_field ? { value_field: data.value_field } : {}),
    ...data.stats,
    ...(data.skipped.length ? { skipped_examples: data.skipped.slice(0, 8) } : {}),
  };
  if (data.stats.plotted) result.summary = await summarize(layer, { limit: 5 });
  return result;
}

function applyLayerFields(layer, body) {
  if (body.title) layer.title = body.title;
  if (body.description != null) layer.description = body.description;
  if (body.source != null) layer.source = body.source;
  if (body.visible != null) layer.visible = !!body.visible;
  if (body.value_field && layer.type === 'regions') layer.value_field = body.value_field;
  if (body.weight_field && layer.type === 'points') layer.weight_field = body.weight_field;
  if (layer.type === 'regions' && ['sum', 'mean', 'none'].includes(body.aggregate)) layer.aggregate = body.aggregate;
  const style = body.style && typeof body.style === 'object' ? body.style : {};
  if (typeof body.style === 'string') style.mode = body.style;
  for (const k of ['mode', 'color', 'palette', 'radius', 'opacity', 'reverse']) if (style[k] != null) layer.style[k] = style[k];
  if (!STYLES[layer.type].includes(layer.style.mode)) layer.style.mode = STYLES[layer.type][0];
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const gzCache = new Map();

async function serveFile(req, res, abs) {
  const ext = path.extname(abs);
  let body;
  try {
    body = await readFile(abs);
  } catch {
    return send(res, 404, { error: 'Not found' });
  }
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  if (body.length > 20000 && /gzip/.test(req.headers['accept-encoding'] || '') && ext !== '.png') {
    const s = await stat(abs);
    const key = `${abs}:${s.mtimeMs}`;
    if (!gzCache.has(key)) gzCache.set(key, zlib.gzipSync(body));
    body = gzCache.get(key);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(200, headers);
  res.end(body);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 30e6) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw httpError(413, 'Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const body = req.method === 'POST' ? await readBody(req) : null;

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: state_changed\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (p === '/api/state' && req.method === 'GET') return send(res, 200, publicState());

  if (p === '/api/title' && req.method === 'POST') {
    if (body.title != null) state.title = String(body.title);
    if (body.subtitle != null) state.subtitle = String(body.subtitle);
    await saveState();
    return send(res, 200, { title: state.title, subtitle: state.subtitle });
  }

  // Regions
  if (p === '/api/regions/find') {
    return send(res, 200, { matches: regions.find(q.q || '', { level: q.level, within: q.within, limit: Number(q.limit) || 5 }) });
  }
  if (p === '/api/regions/list') {
    const parent = q.parent || 'in';
    if (!regions.get(parent)) throw httpError(404, `Unknown region: ${parent}`);
    return send(res, 200, { parent, regions: regions.children(parent, q.level) });
  }
  if (p === '/api/regions/get') {
    const r = regions.get(q.id);
    if (!r) throw httpError(404, `Unknown region: ${q.id}`);
    return send(res, 200, { ...r, chain: regions.chain(r.id) });
  }
  if (p === '/api/regions/locate') {
    return send(res, 200, regions.locate(Number(q.lng), Number(q.lat)));
  }

  // Layers
  if (p === '/api/layers' && req.method === 'POST') return send(res, 200, await upsertLayer(body));
  if (p === '/api/layers/data') {
    const layer = findLayer(q.id);
    if (!layer) throw httpError(404, `Unknown layer: ${q.id}`);
    const data = await layerData(layer);
    return send(res, 200, { ...data, skipped: undefined });
  }
  if (p === '/api/layers/update' && req.method === 'POST') {
    const layer = findLayer(body.id);
    if (!layer) throw httpError(404, `Unknown layer: ${body.id}`);
    applyLayerFields(layer, body);
    if (Array.isArray(body.order)) state.layers.sort((a, b) => body.order.indexOf(a.id) - body.order.indexOf(b.id));
    await saveState();
    return send(res, 200, { layer_id: layer.id, title: layer.title, visible: layer.visible, style: layer.style });
  }
  if (p === '/api/layers/remove' && req.method === 'POST') {
    const before = state.layers.length;
    state.layers = state.layers.filter((l) => l.id !== body.id);
    if (state.layers.length === before) throw httpError(404, `Unknown layer: ${body.id}`);
    cache.delete(body.id);
    await saveState();
    return send(res, 200, { removed: body.id, files_kept: true });
  }
  if (p === '/api/layers/summary') {
    const layer = findLayer(q.id);
    if (!layer) throw httpError(404, `Unknown layer: ${q.id}`);
    return send(res, 200, await summarize(layer, { by: q.by, within: q.within, limit: Number(q.limit) || 15 }));
  }

  // Claude moves everyone's view
  if (p === '/api/view' && req.method === 'POST') {
    if (body.region_id && !regions.get(body.region_id)) throw httpError(404, `Unknown region: ${body.region_id}`);
    broadcast('view', { region_id: body.region_id || 'in', by: body.by || 'claude' });
    return send(res, 200, { ok: true });
  }

  // Exports (PNG composed by the page)
  if (p === '/api/exports' && req.method === 'POST') {
    const m = /^data:image\/png;base64,(.+)$/.exec(body.data_url || '');
    if (!m) throw httpError(400, 'data_url must be a PNG data URL');
    const base = `${slug(body.name || state.title || 'map')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
    await mkdir(EXPORTS, { recursive: true });
    let name = `${base}.png`;
    for (let n = 2; fs.existsSync(path.join(EXPORTS, name)); n++) name = `${base}-${n}.png`;
    const abs = path.join(EXPORTS, name);
    await writeFile(abs, Buffer.from(m[1], 'base64'));
    return send(res, 200, { file: abs, url: `/exports/${name}` });
  }

  throw httpError(404, 'Unknown endpoint');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/data/')) {
      const abs = path.resolve(DATA_DIR, '.' + decodeURIComponent(url.pathname.slice(5)));
      if (!abs.startsWith(DATA_DIR + path.sep)) return send(res, 400, { error: 'Bad path' });
      return await serveFile(req, res, abs);
    }
    if (url.pathname.startsWith('/exports/')) {
      const abs = path.resolve(EXPORTS, '.' + decodeURIComponent(url.pathname.slice(8)));
      if (!abs.startsWith(EXPORTS + path.sep)) return send(res, 400, { error: 'Bad path' });
      return await serveFile(req, res, abs);
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const abs = path.resolve(APP_DIR, rel);
    if (!abs.startsWith(APP_DIR + path.sep)) return send(res, 400, { error: 'Bad path' });
    return await serveFile(req, res, abs);
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.message, ...(err.details || {}) });
    if (!err.status) console.error(err);
  }
});

// Files changed on disk (Claude appended rows, rewrote a CSV) -> tell the pages to reload those layers
function watchWorkspace() {
  const pending = new Set();
  let timer = null;
  fs.watch(WORK, { recursive: true }, (_event, name) => {
    if (!name) return;
    const rel = name.split(path.sep).join('/');
    if (rel.startsWith('.maps/') || rel.startsWith('exports/')) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const changed = [...pending];
      pending.clear();
      for (const layer of state.layers) {
        if (!layer.files.some((f) => changed.includes(f))) continue;
        try {
          const data = await layerData(layer);
          layer.stats = data.stats;
          broadcast('layer_data_changed', { id: layer.id, by: 'file', stats: data.stats, key: data.key });
        } catch (err) {
          console.error(`Reloading ${layer.id}:`, err.message);
        }
      }
      await saveState();
    }, 400);
  });
}

await mkdir(WORK, { recursive: true });
await regions.load();
await loadState();
watchWorkspace();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Maps on http://127.0.0.1:${PORT}`);
  console.log(`Workspace: ${WORK}`);
});
