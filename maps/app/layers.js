// Turns the rows Claude plots into map data: points placed in their state / district / sub-district, or values
// matched to regions. Pure functions over a RegionIndex, so the page (and tests in Node) can run them.
import { parseData } from './lib/parse.js';

// sources: [{ file, rows }] in the order they were added; rows is a file's text or parsed rows
export async function layerData(regions, layer, sources) {
  return layer.type === 'points' ? loadPoints(regions, layer, sources) : loadRegionValues(regions, layer, sources);
}

function parseSource(src, skipped) {
  try {
    return parseData(src.rows, src.file);
  } catch (err) {
    skipped.push({ file: src.file, reason: err.message });
    return null;
  }
}

async function loadPoints(regions, layer, sources) {
  const seen = new Set();
  const features = [];
  const skipped = [];
  let rows = 0;
  for (const src of sources) {
    const { file } = src;
    const records = parseSource(src, skipped);
    if (!records) continue;
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
        where = await regions.locate(coords[0], coords[1]);
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

async function loadRegionValues(regions, layer, sources) {
  const values = {};
  const skipped = [];
  let rows = 0;
  let valueField = layer.value_field;
  let columns;
  for (const src of sources) {
    const { file } = src;
    const records = parseSource(src, skipped);
    if (!records) continue;
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

export function summarize(regions, layer, data, { by, within, limit = 15 } = {}) {
  const scope = regions.get(within ? regions.resolveId(within) : 'in');
  if (!scope) throw new Error(`Unknown region: ${within}`);
  const level = by || CHILD[scope.level];
  if (!level) throw new Error(`Can't group a ${scope.level} into smaller regions`);

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

// ---------- Layer settings ----------

export const STYLES = { points: ['heatmap', 'dots'], regions: ['choropleth'] };

export function slug(s) {
  return String(s || 'layer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'layer';
}

export function applyLayerFields(layer, body) {
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
