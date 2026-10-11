// The map's saved state, kept in this browser: the title and layer settings in localStorage (small, and its
// `storage` event tells other open tabs to redraw), and the rows plotted into each layer in IndexedDB (no size cap).
// Claude passes the rows in the tool call (the bridge inlines a file with {"$file": "path"}), so nothing here
// reads files: to update a layer after editing a file, Claude plots it again.
import { layerData, summarize, applyLayerFields, slug } from './layers.js';

const STATE_KEY = 'maps.state';
const VIEW_KEY = 'maps.view';

// ---------- IndexedDB: one record per (layer, file) ----------

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('maps', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sources', { keyPath: ['layer', 'file'] }).createIndex('layer', 'layer');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const t = (await db()).transaction('sources', mode);
  const out = fn(t.objectStore('sources'));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = t.onabort = () => reject(t.error);
  });
  return out instanceof IDBRequest ? out.result : out;
}

const sourcesOf = (layerId) => tx('readonly', (s) => s.index('layer').getAll(layerId));

// ---------- Store ----------

export function createStore(regions, { onChange, onView } = {}) {
  let state = read();
  const cache = new Map(); // layer id -> { key, data }

  function read() {
    try {
      return { title: '', subtitle: '', layers: [], ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') };
    } catch {
      return { title: '', subtitle: '', layers: [] };
    }
  }

  // Every change starts from what's saved, so a tab that sat idle doesn't undo another tab's changes
  function fresh() {
    state = read();
    return state;
  }

  function commit() {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    onChange?.(publicState());
  }

  // Another tab changed the map
  addEventListener('storage', (e) => {
    if (e.key === STATE_KEY) {
      state = read();
      onChange?.(publicState());
    }
    if (e.key === VIEW_KEY && e.newValue) {
      try {
        onView?.(JSON.parse(e.newValue).region_id);
      } catch {}
    }
  });

  const publicState = () => ({ ...structuredClone(state), boundaries: regions.source });
  const findLayer = (id) => state.layers.find((l) => l.id === id);
  const cacheKey = (layer) => JSON.stringify([layer.rev, layer.files, layer.type, layer.level, layer.value_field, layer.weight_field]);

  async function data(layer) {
    const key = cacheKey(layer);
    const hit = cache.get(layer.id);
    if (hit?.key === key) return hit.data;
    const stored = await sourcesOf(layer.id);
    const byFile = new Map(stored.map((s) => [s.file, s]));
    const d = await layerData(regions, layer, layer.files.map((f) => byFile.get(f) || { file: f, rows: '' }));
    d.key = key;
    cache.set(layer.id, { key, data: d });
    return d;
  }

  function need(id) {
    const layer = findLayer(id);
    if (!layer) throw new Error(`Unknown layer: ${id}`);
    return layer;
  }

  async function plot(body) {
    fresh();
    const type = body.type === 'regions' ? 'regions' : 'points';
    if (body.rows == null || body.rows === '') {
      throw new Error('rows is required: pass the file\'s contents as {"$file": "workspace/<path>"} (the page can\'t read files itself), or an array of row objects');
    }
    const file = String(body.file || '').trim() || 'inline';

    const existing = body.id ? findLayer(body.id) : null;
    const now = new Date().toISOString();
    let layer;
    if (existing) {
      delete body.title; // appending keeps the layer's name; rename with update_layer
      if (existing.type !== type) throw new Error(`Layer "${existing.id}" holds ${existing.type}, not ${type}`);
      layer = structuredClone(existing);
      if (body.append === false) layer.files = [file];
      else if (!layer.files.includes(file)) layer.files.push(file);
    } else {
      if (!body.title?.trim()) throw new Error('title is required for a new layer');
      if (type === 'regions' && !['state', 'district', 'subdistrict'].includes(body.level)) {
        throw new Error('level must be state, district or subdistrict');
      }
      let id = slug(body.id || body.title);
      while (findLayer(id)) id = `${id}-2`;
      layer = { id, title: body.title.trim(), type, level: type === 'regions' ? body.level : undefined, files: [file], style: {}, visible: true, created_at: now };
    }
    applyLayerFields(layer, body);
    layer.updated_at = now;
    layer.rev = (layer.rev || 0) + 1;

    // Check the data before changing the map: rows with nothing plottable don't create or break a layer
    const stored = existing ? await sourcesOf(layer.id) : [];
    const byFile = new Map(stored.map((s) => [s.file, s]));
    byFile.set(file, { layer: layer.id, file, rows: body.rows, saved_at: now });
    const d = await layerData(regions, layer, layer.files.map((f) => byFile.get(f) || { file: f, rows: '' }));
    if (!d.stats.plotted) {
      const err = new Error(`Nothing in ${file} could be plotted, so the map was not changed`);
      err.details = { rows: d.stats.rows, skipped_examples: d.skipped.slice(0, 8), ...(d.columns ? { columns: d.columns } : {}) };
      throw err;
    }
    layer.stats = d.stats;
    // A heatmap of a handful of points is a few faint blobs: default small layers to dots
    const askedMode = typeof body.style === 'string' ? body.style : body.style?.mode;
    if (!existing && type === 'points' && !askedMode) layer.style.mode = d.stats.plotted >= 200 ? 'heatmap' : 'dots';

    await tx('readwrite', (s) => {
      s.put(byFile.get(file));
      for (const old of stored) if (!layer.files.includes(old.file)) s.delete([layer.id, old.file]);
    });
    d.key = cacheKey(layer);
    cache.set(layer.id, { key: d.key, data: d });

    fresh();
    const current = findLayer(layer.id);
    if (current) Object.assign(current, layer);
    else state.layers.push(layer);
    commit();

    const result = {
      layer_id: layer.id,
      title: layer.title,
      files: layer.files,
      ...(d.value_field ? { value_field: d.value_field } : {}),
      ...d.stats,
      ...(d.skipped.length ? { skipped_examples: d.skipped.slice(0, 8) } : {}),
    };
    result.summary = summarize(regions, layer, d, { limit: 5 });
    return result;
  }

  return {
    state: publicState,
    data: async (id) => data(need(id)),

    plot,

    async summarize(id, opts) {
      const layer = need(id);
      return summarize(regions, layer, await data(layer), opts);
    },

    update(body) {
      fresh();
      const layer = need(body.id);
      applyLayerFields(layer, body);
      if (Array.isArray(body.order)) state.layers.sort((a, b) => body.order.indexOf(a.id) - body.order.indexOf(b.id));
      commit();
      return { layer_id: layer.id, title: layer.title, visible: layer.visible, style: layer.style };
    },

    async remove(id) {
      fresh();
      need(id);
      state.layers = state.layers.filter((l) => l.id !== id);
      cache.delete(id);
      commit();
      await tx('readwrite', (s) => {
        const req = s.index('layer').openKeyCursor(IDBKeyRange.only(id));
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          s.delete(c.primaryKey);
          c.continue();
        };
      });
      return { removed: id, files_kept: true };
    },

    setTitle({ title, subtitle }) {
      fresh();
      if (title != null) state.title = String(title);
      if (subtitle != null) state.subtitle = String(subtitle);
      commit();
      return { title: state.title, subtitle: state.subtitle };
    },

    // Move every other open tab to a region (this tab moves itself)
    broadcastView(regionId) {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ region_id: regionId, at: Date.now() }));
    },
  };
}
