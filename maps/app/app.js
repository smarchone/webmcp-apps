// Map UI. Shows India's admin hierarchy (country -> state -> district -> sub-district) and the data layers
// Claude plots. Layers live on the server; this page renders them and follows live updates over SSE.
import { registerTools } from './tools.js';
import { createTable, save, load } from './table.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const EMPTY = { type: 'FeatureCollection', features: [] };

const CHILD = { country: 'state', state: 'district', district: 'subdistrict' };
const LEVEL_NAME = { country: 'Country', state: 'State', district: 'District', subdistrict: 'Sub-district' };
const INDIA_BOUNDS = [[68, 6.5], [97.5, 37.2]];

const PALETTES = {
  reds: ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15'],
  oranges: ['#feedde', '#fdbe85', '#fd8d3c', '#e6550d', '#a63603'],
  blues: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
  greens: ['#edf8e9', '#bae4b3', '#74c476', '#31a354', '#006d2c'],
  purples: ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
};
const HEAT = ['rgba(251,191,36,0)', 'rgba(251,176,36,.7)', '#f59e0b', '#f97316', '#dc2626', '#7f1d1d'];
const COLORS = ['#d97757', '#3b82c4', '#2f9e62', '#9b59b6', '#e0a526', '#c2412d', '#1aa39a', '#7f8c8d'];

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- State ----------

const index = { byId: new Map(), kids: new Map(), source: null };
const geo = { states: EMPTY, districts: EMPTY };
const subByState = new Map(); // state code -> features
const data = new Map(); // layer id -> parsed + derived data
let app = { title: '', subtitle: '', layers: [] };
let focus = 'in';
let hoverId = null;
let map;
let table;

async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

// ---------- Regions ----------

const region = (id) => index.byId.get(id);

function chain(id) {
  const out = {};
  for (let r = region(id); r; r = region(r.parent)) out[r.level] = r.id;
  return out;
}

function lineage(id) {
  const list = [];
  for (let r = region(id); r; r = region(r.parent)) list.unshift(r.id);
  return list;
}

function describe(id) {
  const r = region(id);
  if (!r) return '';
  const above = lineage(id).slice(1, -1).map((x) => region(x).name).reverse();
  return [LEVEL_NAME[r.level], above.join(', ')].filter(Boolean).join(' · ');
}

async function loadIndex() {
  const res = await fetch('/data/india/regions.json').then((r) => r.json());
  index.source = res.source;
  for (const r of res.regions) {
    index.byId.set(r.id, r);
    if (r.parent) {
      if (!index.kids.has(r.parent)) index.kids.set(r.parent, []);
      index.kids.get(r.parent).push(r);
    }
  }
}

async function loadSubdistricts(stateId) {
  const code = region(stateId)?.code;
  if (code == null || subByState.has(code)) return;
  subByState.set(code, []);
  const fc = await fetch(`/data/india/subdistricts/${code}.geojson`).then((r) => (r.ok ? r.json() : EMPTY));
  subByState.set(code, fc.features);
  map.getSource('subdistricts')?.setData({ type: 'FeatureCollection', features: [...subByState.values()].flat() });
}

function featuresAt(level) {
  if (level === 'state') return geo.states.features;
  if (level === 'district') return geo.districts.features;
  return [...subByState.values()].flat();
}

// ---------- Map ----------

function baseStyle() {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      country: { type: 'geojson', data: '/data/india/country.geojson' },
      states: { type: 'geojson', data: geo.states },
      districts: { type: 'geojson', data: geo.districts },
      subdistricts: { type: 'geojson', data: EMPTY },
      labels: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': css('--map-sea') } },
      { id: 'land', type: 'fill', source: 'country', paint: { 'fill-color': css('--map-land') } },
      // choropleths are inserted here (before mask-states)
      { id: 'mask-states', type: 'fill', source: 'states', paint: { 'fill-color': css('--map-mask'), 'fill-opacity': 0.62 }, filter: ['==', ['get', 'id'], ''] },
      { id: 'mask-districts', type: 'fill', source: 'districts', paint: { 'fill-color': css('--map-mask'), 'fill-opacity': 0.55 }, filter: ['==', ['get', 'id'], ''] },
      { id: 'mask-subdistricts', type: 'fill', source: 'subdistricts', paint: { 'fill-color': css('--map-mask'), 'fill-opacity': 0.5 }, filter: ['==', ['get', 'id'], ''] },
      { id: 'hit-states', type: 'fill', source: 'states', paint: { 'fill-opacity': 0 } },
      { id: 'hit-districts', type: 'fill', source: 'districts', paint: { 'fill-opacity': 0 } },
      { id: 'hit-subdistricts', type: 'fill', source: 'subdistricts', paint: { 'fill-opacity': 0 } },
      { id: 'subdistrict-lines', type: 'line', source: 'subdistricts', paint: { 'line-color': css('--map-line'), 'line-width': 0.5 }, filter: ['==', ['get', 'id'], ''] },
      { id: 'district-lines', type: 'line', source: 'districts', paint: { 'line-color': css('--map-line'), 'line-width': 0.4, 'line-opacity': 0.5 } },
      { id: 'state-lines', type: 'line', source: 'states', paint: { 'line-color': css('--map-line-strong'), 'line-width': 0.9, 'line-opacity': 0.75 } },
      { id: 'country-line', type: 'line', source: 'country', paint: { 'line-color': css('--map-line-strong'), 'line-width': 1.3 } },
      { id: 'hover-state', type: 'line', source: 'states', paint: { 'line-color': css('--accent'), 'line-width': 2.2 }, filter: ['==', ['get', 'id'], ''] },
      { id: 'hover-district', type: 'line', source: 'districts', paint: { 'line-color': css('--accent'), 'line-width': 2.2 }, filter: ['==', ['get', 'id'], ''] },
      { id: 'hover-subdistrict', type: 'line', source: 'subdistricts', paint: { 'line-color': css('--accent'), 'line-width': 2.2 }, filter: ['==', ['get', 'id'], ''] },
      // points (heatmaps, dots) are inserted here (before labels)
      {
        id: 'labels',
        type: 'symbol',
        source: 'labels',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10.5, 8, 13],
          'text-max-width': 8,
          'text-padding': 3,
        },
        paint: { 'text-color': css('--map-label'), 'text-halo-color': css('--map-halo'), 'text-halo-width': 1.4 },
      },
    ],
  };
}

function applyTheme() {
  if (!map?.isStyleLoaded()) return;
  map.setPaintProperty('bg', 'background-color', css('--map-sea'));
  map.setPaintProperty('land', 'fill-color', css('--map-land'));
  for (const l of ['mask-states', 'mask-districts', 'mask-subdistricts']) map.setPaintProperty(l, 'fill-color', css('--map-mask'));
  map.setPaintProperty('subdistrict-lines', 'line-color', css('--map-line'));
  map.setPaintProperty('district-lines', 'line-color', css('--map-line'));
  map.setPaintProperty('state-lines', 'line-color', css('--map-line-strong'));
  map.setPaintProperty('country-line', 'line-color', css('--map-line-strong'));
  map.setPaintProperty('labels', 'text-color', css('--map-label'));
  map.setPaintProperty('labels', 'text-halo-color', css('--map-halo'));
  applyFocus({ fly: false });
}

// ---------- Focus (drill down / up) ----------

const NONE = ['==', ['get', 'id'], ''];

export async function setFocus(id, { fly = true } = {}) {
  if (!region(id)) throw new Error(`Unknown region: ${id}`);
  focus = id;
  const c = chain(id);
  if (c.state) await loadSubdistricts(c.state);
  applyFocus({ fly });
  history.replaceState(null, '', id === 'in' ? location.pathname : `#${id}`);
}

function applyFocus({ fly }) {
  const r = region(focus);
  const c = chain(focus);
  const st = c.state;
  const dt = c.district;

  map.setFilter('mask-states', st ? ['!=', ['get', 'id'], st] : NONE);
  map.setFilter('mask-districts', dt ? ['all', ['==', ['get', 'state'], st], ['!=', ['get', 'id'], dt]] : NONE);
  map.setFilter('mask-subdistricts', r.level === 'subdistrict' ? ['all', ['==', ['get', 'parent'], dt], ['!=', ['get', 'id'], focus]] : NONE);
  map.setFilter('subdistrict-lines', dt ? ['==', ['get', 'parent'], dt] : NONE);

  // Districts: faint across India, clear inside the focused state
  const strong = css('--map-line-strong');
  const faint = css('--map-line');
  map.setPaintProperty('district-lines', 'line-color', st ? ['case', ['==', ['get', 'state'], st], strong, faint] : faint);
  map.setPaintProperty('district-lines', 'line-width', st ? ['case', ['==', ['get', 'state'], st], 0.7, 0.35] : 0.4);
  map.setPaintProperty('district-lines', 'line-opacity', st ? 0.8 : ['interpolate', ['linear'], ['zoom'], 4, 0.35, 6, 0.7]);

  // Labels: the regions one level down (or siblings, at the bottom of the tree)
  const labelled = r.level === 'subdistrict' ? index.kids.get(r.parent) || [] : index.kids.get(focus) || [];
  map.getSource('labels').setData({
    type: 'FeatureCollection',
    features: labelled.filter((x) => x.label).map((x) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: x.label }, properties: { name: x.name } })),
  });

  if (fly) {
    if (focus === 'in') map.fitBounds(INDIA_BOUNDS, { padding: viewPadding(24), duration: 700 });
    else map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: viewPadding(48), duration: 700, maxZoom: 11 });
  }
  renderCrumbs();
  renderRegion();
  table?.render();
}

// Keep what we fly to clear of the table drawer
function viewPadding(base) {
  const t = $('table');
  return { top: base, left: base, right: base, bottom: base + (t.hidden ? 0 : t.offsetHeight) };
}

// What a click at this point would select: one level below the deepest region shared with the focus
function targetAt(point) {
  const hit = (layer) => map.queryRenderedFeatures(point, { layers: [layer] })[0]?.properties.id;
  const clicked = ['in', hit('hit-states'), hit('hit-districts'), hit('hit-subdistricts')];
  const end = clicked.findIndex((x) => !x);
  const path = end === -1 ? clicked : clicked.slice(0, end);
  if (path.length < 2) return null;
  const mine = lineage(focus);
  let i = 0;
  while (i < path.length && path[i] === mine[i]) i++;
  return path[Math.min(i, path.length - 1)];
}

// ---------- Data layers ----------

const sourceId = (id) => `src-${id}`;
const mapLayerIds = (id) => [`data-${id}-fill`, `data-${id}-heat`, `data-${id}-dot`];

// Legend filters: layer id -> Set of hidden legend keys (category names, or class indexes for choropleths)
const hidden = new Map(Object.entries(readJSON('maps.hidden') || {}).map(([k, v]) => [k, new Set(v)]));

function readJSON(key) {
  try {
    return JSON.parse(load(key));
  } catch {
    return null;
  }
}

const OTHER = '__other';
const pointKey = (d, p) => (p._category == null || p._category === '' ? OTHER : d.catColors.has(String(p._category)) ? String(p._category) : OTHER);
const classOf = (d, v) => {
  const i = d.breaks.findIndex((b) => v < b);
  return `c${i === -1 ? d.breaks.length : i}`;
};

async function loadLayer(layer) {
  const d = await api(`/api/layers/data?id=${encodeURIComponent(layer.id)}`);
  if (d.type === 'points') {
    d.allFeatures = d.geojson.features;
    d.categories = new Map();
    let maxW = 1;
    for (const f of d.allFeatures) {
      const p = f.properties;
      maxW = Math.max(maxW, p._w);
      if (p._category != null && p._category !== '') d.categories.set(String(p._category), (d.categories.get(String(p._category)) || 0) + 1);
    }
    d.maxW = maxW;
    const ws = d.allFeatures.map((f) => f.properties._w).sort((a, b) => a - b);
    d.capW = Math.max(1, ws[Math.floor(ws.length * 0.95)] ?? 1);
    // Most common categories get colours; the rest share grey
    d.catColors = new Map([...d.categories].sort((a, b) => b[1] - a[1]).slice(0, COLORS.length - 1).map(([c], i) => [c, COLORS[i]]));
  } else {
    if (d.level === 'subdistrict') {
      const states = new Set(Object.keys(d.values).map((id) => chain(id).state));
      await Promise.all([...states].map(loadSubdistricts));
    }
    d.allValues = d.values;
    const vals = Object.values(d.values).map((v) => v.value).sort((a, b) => a - b);
    d.breaks = quantileBreaks(vals, 5);
    d.range = vals.length ? [vals[0], vals[vals.length - 1]] : [0, 0];
  }
  data.set(layer.id, d);
  derive(layer.id);
  return d;
}

// Apply the layer's legend filters: what the map, panel stats and table show
function derive(id) {
  const d = data.get(id);
  const off = hidden.get(id) || new Set();
  let mapData;
  if (d.type === 'points') {
    for (const f of d.allFeatures) f.properties._on = !off.has(pointKey(d, f.properties));
    const features = off.size ? d.allFeatures.filter((f) => f.properties._on) : d.allFeatures;
    d.geojson = { type: 'FeatureCollection', features };
    mapData = { type: 'FeatureCollection', features: d.allFeatures };
    d.counts = new Map();
    for (const f of features) {
      const p = f.properties;
      for (const rid of ['in', p._state, p._district, p._subdistrict]) {
        if (!rid) continue;
        const c = d.counts.get(rid) || { count: 0, weight: 0 };
        c.count++;
        c.weight += p._w;
        d.counts.set(rid, c);
      }
    }
  } else {
    d.values = Object.fromEntries(Object.entries(d.allValues).filter(([, v]) => !off.has(classOf(d, v.value))));
    // Totals for the regions above the data's level
    d.agg = new Map();
    for (const [rid, v] of Object.entries(d.values)) {
      for (const up of lineage(rid).slice(0, -1)) {
        const a = d.agg.get(up) || { sum: 0, n: 0, max: -Infinity };
        a.sum += v.value;
        a.n++;
        a.max = Math.max(a.max, v.value);
        d.agg.set(up, a);
      }
    }
    mapData = {
      type: 'FeatureCollection',
      features: featuresAt(d.level)
        .filter((f) => d.allValues[f.properties.id])
        .map((f) => {
          const value = d.allValues[f.properties.id].value;
          return { ...f, properties: { id: f.properties.id, name: f.properties.name, value, _on: !off.has(classOf(d, value)) } };
        }),
    };
    d.geojson = { type: 'FeatureCollection', features: mapData.features.filter((f) => f.properties._on) };
  }
  const src = map.getSource(sourceId(id));
  if (src) src.setData(mapData);
  else map.addSource(sourceId(id), { type: 'geojson', data: mapData });
}

function toggleLegendKey(id, key) {
  const layer = app.layers.find((l) => l.id === id);
  const keys = (legendSpec(layer, data.get(id)).items || []).filter((i) => i.key != null).map((i) => i.key);
  const off = hidden.get(id) || new Set();
  const alreadyOnly = off.size === keys.length - 1 && !off.has(key);
  hidden.set(id, key === '*' || alreadyOnly ? new Set() : new Set(keys.filter((k) => k !== key)));
  save('maps.hidden', JSON.stringify(Object.fromEntries([...hidden].filter(([, v]) => v.size).map(([k, v]) => [k, [...v]]))));
  derive(id);
  renderAll();
}

function quantileBreaks(sorted, k) {
  if (!sorted.length) return [];
  const out = [];
  for (let i = 1; i < k; i++) out.push(sorted[Math.floor((i / k) * sorted.length)]);
  return [...new Set(out)].filter((b) => b > sorted[0]);
}

function palette(layer) {
  const p = PALETTES[layer.style?.palette] || PALETTES.oranges;
  return layer.style?.reverse ? [...p].reverse() : p;
}

function layerColor(layer) {
  return layer.style?.color || COLORS[app.layers.indexOf(layer) % COLORS.length];
}

// One malformed layer shouldn't take the rest of the map down with it
function addLayerSafely(spec, before) {
  try {
    map.addLayer(spec, before);
  } catch (err) {
    console.warn(`Could not draw ${spec.id}:`, err.message);
  }
}

function renderMapLayers() {
  for (const id of map.getStyle().layers.map((l) => l.id)) if (id.startsWith('data-')) map.removeLayer(id);
  for (const layer of app.layers) {
    const d = data.get(layer.id);
    if (!d || !layer.visible) continue;
    const source = sourceId(layer.id);
    const opacity = layer.style?.opacity ?? null;

    if (d.type === 'regions') {
      const colors = palette(layer).slice(0, d.breaks.length + 1);
      let fill = colors[colors.length - 1];
      if (d.breaks.length) {
        fill = ['step', ['get', 'value'], colors[0]];
        d.breaks.forEach((b, i) => fill.push(b, colors[i + 1]));
      }
      addLayerSafely({ id: `data-${layer.id}-fill`, type: 'fill', source, paint: { 'fill-color': fill, 'fill-opacity': ['case', ['get', '_on'], opacity ?? 0.85, 0.12] } }, 'mask-states');
      continue;
    }

    const heat = layer.style?.mode === 'heatmap';
    const r = layer.style?.radius ?? 1;
    if (heat) {
      // The heatmap stays on at every zoom; intensity rises as points spread apart when zoomed in
      addLayerSafely(
        {
          id: `data-${layer.id}-heat`,
          type: 'heatmap',
          source,
          filter: ['==', ['get', '_on'], true],
          paint: {
            'heatmap-weight': ['min', 1, ['/', ['get', '_w'], d.capW]],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 1.8, 12, 3],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 14 * r, 7, 24 * r, 11, 36 * r, 14, 48 * r],
            'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, HEAT[0], 0.08, HEAT[1], 0.3, HEAT[2], 0.5, HEAT[3], 0.75, HEAT[4], 1, HEAT[5]],
            'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 3, opacity ?? 0.9, 10, 0.75, 13, 0.5],
          },
        }
      );
    }
    // Weighted points get proportional dots (by area)
    const size = d.maxW > 1 ? ['+', 0.7, ['*', 2.3, ['sqrt', ['min', 1, ['/', ['get', '_w'], d.maxW]]]]] : 1;
    const color = d.catColors.size
      ? ['match', ['to-string', ['coalesce', ['get', '_category'], '']], ...[...d.catColors].flat(), '#8a8780']
      : layerColor(layer);
    // Over a heatmap, dots fade in from state zoom so individual reports stay findable
    const show = (v) => (heat ? ['interpolate', ['linear'], ['zoom'], 5, 0, 6.5, v] : v);
    addLayerSafely(
      {
        id: `data-${layer.id}-dot`,
        type: 'circle',
        source,
        minzoom: heat ? 5 : 0,
        layout: { 'circle-sort-key': ['case', ['get', '_on'], 1, 0] }, // highlighted points draw on top
        paint: {
          'circle-color': ['case', ['get', '_on'], color, '#9a968e'],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['*', 4, size], 6, ['*', 6, size], 10, ['*', 8, size], 14, ['*', 11, size]],
          'circle-opacity': show(['case', ['get', '_on'], opacity ?? 0.92, 0.18]),
          'circle-stroke-color': css('--dot-stroke'),
          'circle-stroke-width': ['case', ['get', '_approx'], 2.5, 1.5],
          'circle-stroke-opacity': show(['case', ['get', '_on'], 1, 0.2]),
        },
      }
    );
  }
  // Points draw above region names; with points showing, the names step back
  const points = app.layers.some((l) => l.visible && data.get(l.id)?.type === 'points');
  map.setPaintProperty('labels', 'text-opacity', points ? 0.6 : 1);
  map.setLayoutProperty('labels', 'text-size', points ? ['interpolate', ['linear'], ['zoom'], 4, 9.5, 8, 11.5] : ['interpolate', ['linear'], ['zoom'], 4, 10.5, 8, 13]);
}

// ---------- Stats for a region ----------

function statsFor(id) {
  const r = region(id);
  const out = [];
  for (const layer of app.layers) {
    const d = data.get(layer.id);
    if (!d || !layer.visible) continue;
    if (d.type === 'points') {
      const c = d.counts.get(id) || { count: 0, weight: 0 };
      const total = d.counts.get('in')?.count || 0;
      out.push({ layer, kind: 'points', count: c.count, weight: c.weight, share: total ? c.count / total : 0 });
    } else if (d.level === r.level) {
      out.push({ layer, kind: 'value', value: d.values[id]?.value ?? null });
    } else if (d.agg.has(id)) {
      const a = d.agg.get(id);
      out.push({ layer, kind: 'agg', ...a });
    } else {
      // Below the data's level: show the value of the containing region
      const up = chain(id)[d.level];
      out.push({ layer, kind: 'inherited', value: d.values[up]?.value ?? null, from: region(up)?.name });
    }
  }
  return out;
}

function rankedChildren(layer, parentId) {
  const d = data.get(layer.id);
  const level = CHILD[region(parentId).level];
  if (!level) return [];
  const kids = index.kids.get(parentId) || [];
  let rows;
  if (d.type === 'points') rows = kids.map((k) => ({ id: k.id, name: k.name, n: d.counts.get(k.id)?.count || 0 }));
  else if (d.level === level) rows = kids.map((k) => ({ id: k.id, name: k.name, n: d.values[k.id]?.value ?? null }));
  else if (LEVEL_ORDER(d.level) > LEVEL_ORDER(level)) rows = kids.map((k) => ({ id: k.id, name: k.name, n: aggValue(layer, d.agg.get(k.id)) }));
  else return [];
  return rows.filter((x) => x.n).sort((a, b) => b.n - a.n);
}
const LEVEL_ORDER = (l) => ['country', 'state', 'district', 'subdistrict'].indexOf(l);

// Rolling region values up a level: counts add up, rates don't (Claude picks per layer; default shows the highest)
function aggValue(layer, a) {
  if (!a) return null;
  if (layer.aggregate === 'sum') return a.sum;
  if (layer.aggregate === 'mean') return a.sum / a.n;
  return a.max;
}

const plural = (level, n) => (n === 1 ? (level === 'subdistrict' ? 'sub-district' : level) : level === 'subdistrict' ? 'sub-districts' : `${level}s`);

function swatchFor(layer) {
  const d = data.get(layer.id);
  if (d?.type === 'regions') return palette(layer)[3];
  if (layer.style?.mode === 'heatmap') return HEAT[4];
  return layerColor(layer);
}

// ---------- Panel ----------

function renderCrumbs() {
  const ids = lineage(focus);
  $('crumbs').innerHTML = ids
    .map((id, i) => `${i ? '<span>›</span>' : ''}<button data-id="${id}" class="${id === focus ? 'current' : ''}">${esc(region(id).name)}</button>`)
    .join('');
}

function renderRegion() {
  const r = region(focus);
  const stats = statsFor(focus);
  let html = `<h3>${esc(r.name)}</h3><div class="kind">${esc(describe(focus))}</div>`;
  if (app.layers.length && !stats.length) html += '<div class="none">All layers are hidden.</div>';
  for (const s of stats) {
    const head = statLine(s, focus);
    const rows = rankedChildren(s.layer, focus).slice(0, 6);
    const max = rows[0]?.n || 1;
    html += `<div class="stat"><div class="stat-head"><span class="swatch" style="background:${swatchFor(s.layer)}"></span><span>${esc(s.layer.title)}</span></div>
      <div class="stat-head">${head}</div>
      ${rows.length ? `<ul class="bars">${rows.map((x) => `<li data-id="${x.id}"><span>${esc(x.name)}</span><span>${fmt.format(x.n)}</span><i class="bar" style="width:calc(${(x.n / max) * 100}% - 12px)"></i></li>`).join('')}</ul>` : ''}</div>`;
  }
  $('region').innerHTML = html;
}

function statLine(s, id) {
  if (s.kind === 'points') {
    if (!s.count) return '<span class="muted">No points here</span>';
    const share = id === 'in' ? '' : ` <span class="muted">· ${(s.share * 100).toFixed(s.share < 0.1 ? 1 : 0)}% of all</span>`;
    return `<b>${fmt.format(s.count)}</b> <span class="muted">points</span>${share}`;
  }
  if (s.kind === 'value') return s.value == null ? '<span class="muted">No value</span>' : `<b>${fmt.format(s.value)}</b>`;
  if (s.kind === 'agg') {
    const where = `${s.n} ${plural(s.layer.level, s.n)}`;
    if (s.layer.aggregate === 'sum') return `<b>${fmt.format(s.sum)}</b> <span class="muted">total across ${where}</span>`;
    if (s.layer.aggregate === 'mean') return `<b>${fmt.format(s.sum / s.n)}</b> <span class="muted">average of ${where}</span>`;
    return `<span class="muted">${where} with data · highest</span> <b>${fmt.format(s.max)}</b>`;
  }
  return s.value == null ? '<span class="muted">No value</span>' : `<b>${fmt.format(s.value)}</b> <span class="muted">(${esc(s.from)})</span>`;
}

function renderLayers() {
  $('layers-empty').hidden = app.layers.length > 0;
  $('layers').innerHTML = app.layers
    .slice()
    .reverse()
    .map((l) => {
      const d = data.get(l.id);
      const n = d?.stats?.plotted ?? l.stats?.plotted ?? 0;
      const what = l.type === 'points' ? `${fmt.format(n)} points` : `${fmt.format(n)} ${l.level === 'subdistrict' ? 'sub-districts' : `${l.level}s`}`;
      const files = l.files.length > 1 ? ` · ${l.files.length} files` : '';
      const modes = l.type === 'points' ? ['heatmap', 'dots'] : ['choropleth'];
      return `<li class="layer ${l.visible ? '' : 'off'}" data-id="${esc(l.id)}">
        <div class="layer-row">
          <input type="checkbox" data-act="toggle" ${l.visible ? 'checked' : ''} title="Show or hide" />
          <span class="swatch" style="background:${swatchFor(l)}"></span>
          <span class="layer-title" title="${esc(l.title)}">${esc(l.title)}</span>
          ${modes.length > 1 ? `<select data-act="mode">${modes.map((m) => `<option ${l.style?.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select>` : ''}
          <button class="icon-btn" data-act="table" title="Show rows">▦</button>
          <button class="icon-btn" data-act="remove" title="Remove layer">✕</button>
        </div>
        <div class="layer-meta">${what}${files}${l.source ? ` · ${esc(l.source)}` : ''}</div>
        ${l.description ? `<div class="layer-desc">${esc(l.description)}</div>` : ''}
      </li>`;
    })
    .join('');
}

function renderLegend() {
  const parts = [];
  for (const layer of app.layers.slice().reverse()) {
    const d = data.get(layer.id);
    if (!d || !layer.visible) continue;
    const spec = legendSpec(layer, d);
    const anyOff = spec.items?.some((i) => i.hidden);
    parts.push(`<div data-layer="${esc(layer.id)}"><div class="legend-title"><span>${esc(layer.title)}</span>${anyOff ? '<button class="legend-reset" data-key="*">Show all</button>' : ''}</div>${legendBody(spec)}</div>`);
  }
  $('legend').innerHTML = parts.join('');
  $('legend').hidden = !parts.length;
}

// Legend entries; entries with a key can be clicked to hide or show those rows
function legendSpec(layer, d) {
  const off = hidden.get(layer.id) || new Set();
  if (d.type === 'regions') {
    const colors = palette(layer);
    const [lo, hi] = d.range;
    const edges = [lo, ...d.breaks, hi];
    const counts = new Map();
    for (const v of Object.values(d.allValues)) counts.set(classOf(d, v.value), (counts.get(classOf(d, v.value)) || 0) + 1);
    return {
      kind: 'classes',
      items: edges.slice(0, -1).map((e, i) => ({
        key: `c${i}`,
        color: colors[i],
        count: counts.get(`c${i}`) || 0,
        hidden: off.has(`c${i}`),
        label: i === edges.length - 2 ? `${compact.format(e)} – ${compact.format(edges[i + 1])}` : `${compact.format(e)} – <${compact.format(edges[i + 1])}`,
      })),
    };
  }
  let items = null;
  if (d.catColors.size) {
    items = [...d.catColors].map(([label, color]) => ({ key: label, label, color, count: d.categories.get(label), hidden: off.has(label) }));
    const rest = d.allFeatures.length - items.reduce((n, i) => n + i.count, 0);
    if (rest) items.push({ key: OTHER, label: d.categories.size > d.catColors.size ? 'Other' : 'No category', color: '#8a8780', count: rest, hidden: off.has(OTHER) });
  }
  if (layer.style?.mode === 'heatmap') return { kind: 'ramp', colors: HEAT.slice(1), labels: ['Fewer', 'More'], items };
  if (items) return { kind: 'cats', items };
  return { kind: 'cats', items: [{ label: `${fmt.format(d.stats.plotted)} points`, color: layerColor(layer) }] };
}

function legendItems(items, round) {
  return items
    .map((i) => {
      const solo = i.key != null && !i.hidden && items.some((x) => x.hidden);
      const attrs = i.key != null ? `data-key="${esc(i.key)}" title="${solo ? 'Click to show all' : 'Click to highlight only this'}"` : '';
      return `<div class="legend-item ${i.key != null ? 'toggle' : ''} ${i.hidden ? 'off' : ''} ${solo ? 'solo' : ''}" ${attrs}><span class="swatch" style="background:${i.color}${round ? ';border-radius:50%' : ''}"></span><span class="legend-label">${esc(i.label)}</span>${i.count != null ? `<span class="legend-count">${fmt.format(i.count)}</span>` : ''}</div>`;
    })
    .join('');
}

function legendBody(s) {
  if (s.kind === 'ramp') {
    return `<div class="ramp" style="background:linear-gradient(90deg,${s.colors.join(',')})"></div><div class="ramp-labels"><span>${s.labels[0]}</span><span>${s.labels[1]}</span></div>${s.items ? `<div class="legend-items">${legendItems(s.items, true)}</div>` : ''}`;
  }
  return `<div class="legend-items">${legendItems(s.items, s.kind === 'cats')}</div>`;
}

function renderHeadline() {
  $('map-title').textContent = app.title || 'India';
  $('map-subtitle').textContent = app.subtitle || '';
  document.title = app.title ? `${app.title} · Maps` : 'Maps';
}

function sourcesText() {
  const data = [...new Set(app.layers.filter((l) => l.visible && l.source).map((l) => l.source))];
  const b = index.source;
  return {
    data: data.length ? `Data: ${data.join('; ')}.` : '',
    boundaries: `Boundaries: ${b?.name || 'LGD'} (${b?.vintage || ''}, ${b?.licence || ''}). Boundaries are indicative and may not be authoritative.`,
  };
}

function renderSources() {
  const s = sourcesText();
  $('sources').innerHTML = `${esc(s.data)} ${s.data ? '<br/>' : ''}${esc(s.boundaries).replace('Bharatlas', '<a href="https://bharatlas.com" target="_blank" rel="noopener">Bharatlas</a>')}`;
}

function renderAll() {
  renderMapLayers();
  renderLayers();
  renderLegend();
  renderRegion();
  renderHeadline();
  renderSources();
  table?.render();
}

// ---------- Sync with the server ----------

let syncing = Promise.resolve();

function sync(next) {
  syncing = syncing.then(async () => {
    const known = new Set(next.layers.map((l) => l.id));
    for (const id of [...data.keys()]) {
      if (known.has(id)) continue;
      data.delete(id);
      for (const l of mapLayerIds(id)) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(sourceId(id))) map.removeSource(sourceId(id));
    }
    const prev = new Map(app.layers.map((l) => [l.id, l]));
    app = next;
    for (const layer of app.layers) {
      const old = prev.get(layer.id);
      const reload = !data.has(layer.id) || old?.files.join() !== layer.files.join() || old?.value_field !== layer.value_field;
      if (reload) await loadLayer(layer).catch((err) => console.warn(layer.id, err));
    }
    renderAll();
  });
  return syncing;
}

const announced = new Map(); // layer id -> plotted count the user has been told about

function reloadLayer(id, info) {
  syncing = syncing.then(async () => {
    const layer = app.layers.find((l) => l.id === id);
    if (!layer) return;
    const fresh = data.get(id)?.key !== info.key;
    if (fresh) {
      await loadLayer(layer);
      renderAll();
    }
    const n = data.get(id).stats.plotted;
    const before = announced.get(id);
    if (!fresh && before === n) return; // repeat event (file watchers fire twice)
    announced.set(id, n);
    const unit = layer.type === 'points' ? 'points' : plural(layer.level, 2);
    const who = info.by === 'claude' ? 'Claude' : 'A file change';
    if (before == null) toast(`${who} plotted “${layer.title}”: ${fmt.format(n)} ${unit}`);
    else if (n > before) toast(`${who} added ${fmt.format(n - before)} ${unit} to “${layer.title}”`);
    else toast(`“${layer.title}” updated`);
    const el = document.querySelector(`.layer[data-id="${CSS.escape(id)}"]`);
    el?.classList.remove('flash');
    void el?.offsetWidth;
    el?.classList.add('flash');
  });
  return syncing;
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    $('status').textContent = 'Live';
    $('status').classList.add('live');
  };
  es.onerror = () => {
    $('status').textContent = 'Offline';
    $('status').classList.remove('live');
  };
  es.addEventListener('state_changed', (e) => sync(JSON.parse(e.data)));
  es.addEventListener('layer_data_changed', (e) => {
    const info = JSON.parse(e.data);
    reloadLayer(info.id, info);
  });
  es.addEventListener('view', (e) => setFocus(JSON.parse(e.data).region_id).catch(() => {}));
}

// ---------- Interaction ----------

function setHover(id) {
  if (id === hoverId) return;
  hoverId = id;
  const level = region(id)?.level;
  for (const l of ['state', 'district', 'subdistrict']) map.setFilter(`hover-${l}`, ['==', ['get', 'id'], level === l ? id : '']);
}

function pointTooltip(f) {
  const p = f.properties;
  const where = [p._subdistrict, p._district, p._state].map((id) => region(id)?.name).filter(Boolean).join(', ');
  return `<b>${esc(p._label || 'Point')}</b>${p._category ? `<div class="kind">${esc(p._category)}${p._date ? ` · ${esc(p._date)}` : ''}</div>` : p._date ? `<div class="kind">${esc(p._date)}</div>` : ''}
    <div class="kind">${esc(where)}${p._approx === true || p._approx === 'true' ? ' · placed at region centre' : ''}</div>`;
}

function regionTooltip(id) {
  const rows = statsFor(id).map((s) => `<div class="row"><span class="swatch" style="background:${swatchFor(s.layer)}"></span>${statLine(s, id)}</div>`);
  return `<b>${esc(region(id).name)}</b><div class="kind">${esc(describe(id))}</div>${rows.join('')}`;
}

function dotLayers() {
  return map.getStyle().layers.filter((l) => l.id.endsWith('-dot')).map((l) => l.id);
}

function bindMap() {
  map.on('mousemove', (e) => {
    const dot = map.queryRenderedFeatures(e.point, { layers: dotLayers() }).find((f) => f.layer.paint?.['circle-opacity'] !== 0);
    const tip = $('tooltip');
    let html = '';
    if (dot) {
      setHover(null);
      html = pointTooltip(dot);
    } else {
      const id = targetAt(e.point);
      setHover(id);
      if (id) html = regionTooltip(id);
    }
    map.getCanvas().style.cursor = html ? 'pointer' : '';
    tip.hidden = !html;
    if (!html) return;
    tip.innerHTML = html;
    const { width, height } = map.getContainer().getBoundingClientRect();
    tip.style.left = `${Math.min(e.point.x + 14, width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.min(e.point.y + 14, height - tip.offsetHeight - 8)}px`;
  });
  map.on('mouseout', () => {
    $('tooltip').hidden = true;
    setHover(null);
  });
  map.on('click', (e) => {
    const dot = map.queryRenderedFeatures(e.point, { layers: dotLayers() })[0];
    if (dot) return openPopup(dot, e.lngLat);
    const id = targetAt(e.point);
    if (id && id !== focus) setFocus(id);
  });
}

let popup;

function openPopup(f, lngLat) {
  const p = f.properties;
  const extra = Object.entries(p).filter(([k, v]) => !k.startsWith('_') && v !== '' && v != null && !/^(lat|lng|lon|latitude|longitude)$/i.test(k));
  const html = `${pointTooltip(f)}
    ${extra.length ? `<dl class="popup-props">${extra.slice(0, 12).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>` : ''}
    ${p._url ? `<p style="margin:6px 0 0"><a href="${esc(p._url)}" target="_blank" rel="noopener">Open source ↗</a></p>` : ''}`;
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(lngLat).setHTML(html).addTo(map);
}

function bindPanel() {
  $('crumbs').addEventListener('click', (e) => {
    const id = e.target.closest('button')?.dataset.id;
    if (id) setFocus(id);
  });
  $('region').addEventListener('click', (e) => {
    const id = e.target.closest('li[data-id]')?.dataset.id;
    if (id) setFocus(id);
  });
  $('home').onclick = () => setFocus('in');
  $('legend').addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    const id = e.target.closest('[data-layer]')?.dataset.layer;
    if (key != null && id) toggleLegendKey(id, key);
  });
  $('open-table').onclick = () => table.toggle();
  bindResizer();
  $('export').onclick = async () => {
    try {
      const out = await exportImage({ format: 'current' });
      const a = document.createElement('a');
      a.href = out.url;
      a.download = out.file.split('/').pop();
      a.click();
      toast(`Saved ${out.file.split('/').slice(-2).join('/')}`);
    } catch (err) {
      toast(`Export failed: ${err.message}`);
    }
  };
  $('layers').addEventListener('change', async (e) => {
    const id = e.target.closest('.layer')?.dataset.id;
    const act = e.target.dataset.act;
    if (act === 'toggle') await api('/api/layers/update', { id, visible: e.target.checked, by: 'user' });
    if (act === 'mode') await api('/api/layers/update', { id, style: { mode: e.target.value }, by: 'user' });
  });
  $('layers').addEventListener('click', async (e) => {
    if (e.target.dataset.act === 'table') return table.open(e.target.closest('.layer').dataset.id);
    if (e.target.dataset.act !== 'remove') return;
    const layer = app.layers.find((l) => l.id === e.target.closest('.layer').dataset.id);
    if (confirm(`Remove “${layer.title}” from the map? Its data files stay in the workspace.`)) await api('/api/layers/remove', { id: layer.id });
  });
  bindSearch();
}

// Drag the panel's edge to resize it; the width is remembered per browser
const PANEL_DEFAULT = 380;

function setPanelWidth(w) {
  const width = Math.round(Math.min(Math.max(w, 280), Math.min(760, window.innerWidth - 320)));
  document.querySelector('.shell').style.setProperty('--panel-w', `${width}px`);
  map?.resize();
  return width;
}

function bindResizer() {
  const handle = $('resizer');
  const saved = Number(load('maps.panelWidth'));
  if (saved) setPanelWidth(saved);
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    let width;
    let frame;
    const move = (ev) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => (width = setPanelWidth(ev.clientX)));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener(
      'pointerup',
      () => {
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        if (width) save('maps.panelWidth', String(width));
      },
      { once: true }
    );
  });
  handle.addEventListener('dblclick', () => save('maps.panelWidth', String(setPanelWidth(PANEL_DEFAULT))));
}

function showPoint(f) {
  const [lng, lat] = f.geometry.coordinates;
  map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 12), duration: 600, padding: viewPadding(0) });
  map.once('moveend', () => openPopup(f, { lng, lat }));
}

// Region search (client side)
function norm(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function bindSearch() {
  const input = $('search');
  const list = $('results');
  let results = [];
  let active = 0;
  const show = () => {
    list.hidden = !results.length;
    list.innerHTML = results.map((r, i) => `<li data-id="${r.id}" class="${i === active ? 'active' : ''}">${esc(r.name)} <small>${esc(describe(r.id))}</small></li>`).join('');
  };
  input.addEventListener('input', () => {
    const q = norm(input.value);
    active = 0;
    if (q.length < 2) {
      results = [];
      return show();
    }
    const scored = [];
    for (const r of index.byId.values()) {
      const n = norm(r.name);
      const s = n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0;
      if (s) scored.push({ r, s: s + (3 - LEVEL_ORDER(r.level)) * 0.1 });
    }
    results = scored.sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.r);
    show();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') active = Math.min(active + 1, results.length - 1);
    else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0);
    else if (e.key === 'Enter' && results[active]) {
      setFocus(results[active].id);
      input.value = '';
      results = [];
    } else if (e.key === 'Escape') results = [];
    else return;
    e.preventDefault();
    show();
  });
  list.addEventListener('mousedown', (e) => {
    const id = e.target.closest('li')?.dataset.id;
    if (!id) return;
    setFocus(id);
    input.value = '';
    results = [];
    show();
  });
  input.addEventListener('blur', () => setTimeout(() => ((results = []), show()), 150));
}

// ---------- Export ----------

const FORMATS = { square: [1080, 1080], wide: [1600, 900], portrait: [1080, 1350] };

function idle() {
  return new Promise((resolve) => {
    map.once('idle', resolve);
    map.triggerRepaint();
  });
}

export async function exportImage({ format = 'current', title, subtitle } = {}) {
  await syncing;
  const stage = $('stage');
  const el = $('map');
  const dims = FORMATS[format];
  // Fixed formats render at 2x so labels and lines stay legible in a 1080/1600 px image
  const ratio = dims ? 2 : window.devicePixelRatio || 1;
  const cssWidth = dims ? dims[0] / ratio : el.clientWidth;
  const s = Math.min(1.25, Math.max(0.8, cssWidth / 1000)); // type scale, in CSS px
  const px = (v) => Math.round(v * ratio); // CSS px -> image px
  const headTitle = title ?? (app.title || region(focus).name);
  const headSub = subtitle ?? app.subtitle ?? '';
  const header = Math.round((headSub ? 108 : 78) * s);
  const footer = Math.round(64 * s);

  const restore = [];
  if (dims) {
    stage.classList.add('exporting');
    el.style.width = `${cssWidth}px`;
    el.style.height = `${dims[1] / ratio - header - footer}px`;
    const before = map.getPixelRatio();
    const camera = { center: map.getCenter(), zoom: map.getZoom() };
    map.setPixelRatio(ratio);
    map.resize();
    restore.push(() => {
      stage.classList.remove('exporting');
      el.style.width = el.style.height = '';
      map.setPixelRatio(before);
      map.resize();
      map.jumpTo(camera);
    });
    const r = region(focus);
    if (focus === 'in') map.fitBounds(INDIA_BOUNDS, { padding: 20 * s, duration: 0 });
    else map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { padding: 36 * s, duration: 0, maxZoom: 11 });
  }
  try {
    await new Promise((r) => setTimeout(r, 50));
    await idle();
    const src = map.getCanvas();
    const W = src.width;
    const H = px(header) + src.height + px(footer);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const g = out.getContext('2d');
    const font = (size, weight = 400) => `${weight} ${px(size)}px Inter, system-ui, sans-serif`;

    g.fillStyle = css('--map-land');
    g.fillRect(0, 0, W, H);
    g.drawImage(src, 0, px(header));

    // Header
    g.fillStyle = css('--text');
    g.font = font(30 * s, 700);
    g.textBaseline = 'alphabetic';
    g.fillText(headTitle, px(32 * s), px(50 * s), W - px(64 * s));
    if (headSub) {
      g.fillStyle = css('--muted');
      g.font = font(19 * s, 400);
      g.fillText(headSub, px(32 * s), px(84 * s), W - px(64 * s));
    }

    // Legend, bottom-left of the map
    const imageFont = (size, weight = 400) => `${weight} ${Math.round(size)}px Inter, system-ui, sans-serif`;
    drawLegend(g, { x: px(20 * s), bottom: px(header) + src.height - px(20 * s), unit: ratio * s, font: imageFont });

    // Footer
    const srcs = sourcesText();
    g.fillStyle = css('--muted');
    g.font = font(12.5 * s);
    const footY = px(header) + src.height;
    wrapText(g, [srcs.data, srcs.boundaries].filter(Boolean).join(' '), px(32 * s), footY + px(24 * s), W - px(260 * s), px(17 * s));
    g.textAlign = 'right';
    g.font = font(13 * s, 600);
    g.fillText(`${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`, W - px(32 * s), footY + px(26 * s));
    g.font = font(12 * s);
    g.fillText('Made with Claude Code', W - px(32 * s), footY + px(44 * s));
    g.textAlign = 'left';

    const res = await api('/api/exports', { data_url: out.toDataURL('image/png'), name: headTitle });
    return { ...res, width: W, height: H, format };
  } finally {
    restore.forEach((f) => f());
  }
}

function wrapText(g, text, x, y, maxWidth, lineHeight) {
  let line = '';
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxWidth && line) {
      g.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else line = test;
  }
  if (line) g.fillText(line, x, y);
}

function drawLegend(g, { x, bottom, unit, font }) {
  const blocks = [];
  for (const layer of app.layers.slice().reverse()) {
    const d = data.get(layer.id);
    if (!d || !layer.visible) continue;
    const spec = legendSpec(layer, d);
    if (spec.items) spec.items = spec.items.filter((i) => !i.hidden);
    if (spec.kind === 'ramp') delete spec.items;
    blocks.push({ layer, spec });
  }
  if (!blocks.length) return;
  const pad = 12 * unit;
  const w = 250 * unit;
  const row = 18 * unit;
  const heights = blocks.map(({ spec }) => 20 * unit + (spec.kind === 'ramp' ? 28 * unit : spec.kind === 'cats' ? Math.ceil(spec.items.length / 2) * row : spec.items.length * row));
  const h = pad * 2 + heights.reduce((a, b) => a + b, 0) + (blocks.length - 1) * 10 * unit;
  let y = bottom - h;
  g.fillStyle = css('--card');
  g.strokeStyle = css('--border');
  g.lineWidth = unit;
  g.beginPath();
  g.roundRect(x, y, w, h, 10 * unit);
  g.fill();
  g.stroke();
  y += pad;
  for (const [i, { layer, spec }] of blocks.entries()) {
    g.fillStyle = css('--text');
    g.font = font(12.5 * unit, 600);
    g.fillText(layer.title, x + pad, y + 13 * unit, w - pad * 2);
    let yy = y + 22 * unit;
    g.font = font(11.5 * unit);
    if (spec.kind === 'ramp') {
      const grad = g.createLinearGradient(x + pad, 0, x + w - pad, 0);
      spec.colors.forEach((c, j) => grad.addColorStop(j / (spec.colors.length - 1), c));
      g.fillStyle = grad;
      g.fillRect(x + pad, yy, w - pad * 2, 8 * unit);
      g.fillStyle = css('--muted');
      g.fillText(spec.labels[0], x + pad, yy + 22 * unit);
      g.textAlign = 'right';
      g.fillText(spec.labels[1], x + w - pad, yy + 22 * unit);
      g.textAlign = 'left';
    } else {
      spec.items.forEach((item, j) => {
        const col = spec.kind === 'cats' ? j % 2 : 0;
        const rowIdx = spec.kind === 'cats' ? Math.floor(j / 2) : j;
        const ix = x + pad + col * ((w - pad * 2) / 2);
        const iy = yy + rowIdx * row;
        g.fillStyle = item.color;
        g.beginPath();
        if (spec.kind === 'cats') g.arc(ix + 5 * unit, iy + 6 * unit, 5 * unit, 0, Math.PI * 2);
        else g.roundRect(ix, iy, 12 * unit, 12 * unit, 2 * unit);
        g.fill();
        g.fillStyle = css('--text');
        g.fillText(item.label, ix + 18 * unit, iy + 10.5 * unit, (spec.kind === 'cats' ? (w - pad * 2) / 2 : w - pad * 2) - 22 * unit);
      });
    }
    y += heights[i] + 10 * unit;
  }
}

// ---------- Boot ----------

// ---------- Theme ----------

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };

function setTheme(name) {
  if (name === 'light' || name === 'dark') document.documentElement.dataset.theme = name;
  else delete document.documentElement.dataset.theme;
  const btn = $('theme');
  btn.textContent = THEME_LABEL[name] || THEME_LABEL.system;
  btn.title = `Theme: ${name === 'system' || !name ? 'follows your system' : name}. Click to change.`;
}

function themeChanged() {
  requestAnimationFrame(() => {
    applyTheme();
    renderMapLayers();
  });
}

async function main() {
  setTheme(load('maps.theme') || 'system');
  const [states, districts] = await Promise.all([
    fetch('/data/india/states.geojson').then((r) => r.json()),
    fetch('/data/india/districts.geojson').then((r) => r.json()),
    loadIndex(),
  ]);
  geo.states = states;
  geo.districts = districts;

  map = new maplibregl.Map({
    container: 'map',
    style: baseStyle(),
    bounds: INDIA_BOUNDS,
    fitBoundsOptions: { padding: 24 },
    minZoom: 2,
    maxZoom: 14,
    dragRotate: false,
    pitchWithRotate: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  await new Promise((r) => map.on('load', r));
  window.__map = map;

  bindMap();
  table = createTable({
    $,
    esc,
    fmt,
    region,
    lineage,
    getFocus: () => focus,
    getLayers: () => app.layers,
    getData: (id) => data.get(id),
    onPoint: showPoint,
    onRegion: (id) => setFocus(id),
    // Shift the map so what was in the middle stays visible above (or below) the drawer
    onToggle: (h) => map.panBy([0, h / 2], { duration: 250 }),
  });
  bindPanel();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);
  $('theme').onclick = () => {
    const next = THEMES[(THEMES.indexOf(load('maps.theme') || 'system') + 1) % THEMES.length];
    save('maps.theme', next);
    setTheme(next);
    themeChanged();
  };

  const start = decodeURIComponent(location.hash.slice(1));
  await setFocus(region(start) ? start : 'in', { fly: !!region(start) && start !== 'in' });
  await sync(await api('/api/state'));
  for (const [id, d] of data) announced.set(id, d.stats.plotted);
  table.restore();
  connect();

  const reg = await registerTools({ getFocus: () => focus, setFocus, exportImage });
  console.log(reg.ok ? `WebMCP: ${reg.count} tools registered` : 'WebMCP not available (document.modelContext missing)');
}

main().catch((err) => {
  console.error(err);
  toast(`Failed to start: ${err.message}`);
});
