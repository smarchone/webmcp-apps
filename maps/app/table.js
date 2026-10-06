// Table view of a layer's rows: sortable, filterable, scoped to the focused region, exportable as CSV.
// Clicking a row shows it on the map.

const LIMIT = 1000;
const HIDDEN = /^(lat|lng|lon|long|latitude|longitude|x|y)$/i;

export function createTable(ctx) {
  const { $, esc, fmt, region, lineage, getFocus, getLayers, getData, onPoint, onRegion, onToggle } = ctx;
  const el = $('table');
  let layerId = null;
  let sort = { col: null, dir: -1 };
  let filter = '';
  let scoped = true;

  function columnsFor(layer, d) {
    if (d.type === 'points') {
      const cols = [
        { key: 'label', title: 'Label', get: (f) => f.properties._label },
        { key: 'category', title: 'Category', get: (f) => f.properties._category },
        { key: 'date', title: 'Date', get: (f) => f.properties._date },
        { key: 'subdistrict', title: 'Sub-district', get: (f) => region(f.properties._subdistrict)?.name },
        { key: 'district', title: 'District', get: (f) => region(f.properties._district)?.name },
        { key: 'state', title: 'State', get: (f) => region(f.properties._state)?.name },
      ];
      if (d.maxW > 1) cols.push({ key: 'weight', title: 'Weight', get: (f) => f.properties._w, num: true });
      const used = new Set(['label', 'title', 'name', 'summary', 'category', 'type', 'kind', 'topic', 'date', 'time', 'timestamp', 'created_at', 'datetime', 'url', 'link', 'source_url', 'weight', 'state', 'district', 'region']);
      for (const k of extraKeys(d.geojson.features.slice(0, 200).map((f) => f.properties), used)) {
        cols.push({ key: `p:${k}`, title: k, get: (f) => f.properties[k] });
      }
      cols.push({ key: 'url', title: '', get: (f) => f.properties._url, link: true });
      return cols.filter((c) => c.link || d.geojson.features.some((f) => blank(c.get(f)) === false));
    }
    const lv = d.level;
    const cols = [{ key: 'region', title: lv === 'subdistrict' ? 'Sub-district' : lv[0].toUpperCase() + lv.slice(1), get: (r) => r.name }];
    if (lv === 'subdistrict') cols.push({ key: 'district', title: 'District', get: (r) => region(region(r.id)?.parent)?.name });
    if (lv !== 'state') cols.push({ key: 'state', title: 'State', get: (r) => region(lineage(r.id)[1])?.name });
    cols.push({ key: 'value', title: d.value_field || 'value', get: (r) => r.value, num: true });
    const used = new Set(['region', 'region_id', 'id', 'name', 'state', 'district', 'subdistrict', String(d.value_field || 'value').toLowerCase()]);
    for (const k of extraKeys(Object.values(d.values).slice(0, 200).map((v) => v.props), used)) {
      cols.push({ key: `p:${k}`, title: k, get: (r) => r.props[k] });
    }
    return cols;
  }

  function extraKeys(objs, used) {
    const keys = new Set();
    for (const o of objs) for (const k of Object.keys(o || {})) if (!k.startsWith('_') && !used.has(k.toLowerCase()) && !HIDDEN.test(k)) keys.add(k);
    return [...keys].slice(0, 12);
  }

  const blank = (v) => v == null || v === '';

  function rowsFor(d) {
    const focus = getFocus();
    const lvl = region(focus)?.level;
    if (d.type === 'points') {
      const all = d.geojson.features;
      return scoped && lvl !== 'country' ? all.filter((f) => f.properties[`_${lvl}`] === focus) : all;
    }
    const all = Object.entries(d.values).map(([id, v]) => ({ id, ...v }));
    if (!scoped || lvl === 'country') return all;
    // Rows inside the focus, or the row that contains it
    return all.filter((r) => lineage(r.id).includes(focus) || lineage(focus).includes(r.id));
  }

  function compare(a, b, col) {
    const x = col.get(a), y = col.get(b);
    if (blank(x)) return blank(y) ? 0 : 1;
    if (blank(y)) return -1;
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * sort.dir;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sort.dir;
  }

  function current() {
    const layers = getLayers().filter((l) => getData(l.id));
    if (!layers.length) return null;
    const layer = layers.find((l) => l.id === layerId) || layers[layers.length - 1];
    layerId = layer.id;
    const d = getData(layer.id);
    const cols = columnsFor(layer, d);
    let rows = rowsFor(d);
    if (filter) {
      const q = filter.toLowerCase();
      rows = rows.filter((r) => cols.some((c) => !blank(c.get(r)) && String(c.get(r)).toLowerCase().includes(q)));
    }
    const col = cols.find((c) => c.key === sort.col) || (d.type === 'regions' ? cols.find((c) => c.key === 'value') : null);
    if (col) rows = [...rows].sort((a, b) => compare(a, b, col));
    return { layers, layer, d, cols, rows, sortedBy: col?.key };
  }

  function render() {
    if (el.hidden) return;
    const c = current();
    const focusName = region(getFocus())?.name;
    if (!c) {
      el.querySelector('.table-body').innerHTML = '<div class="table-empty">No layers yet.</div>';
      el.querySelector('.table-tabs').innerHTML = '';
      el.querySelector('.table-count').textContent = '';
      return;
    }
    el.querySelector('.table-tabs').innerHTML = c.layers
      .map((l) => `<button data-layer="${esc(l.id)}" class="${l.id === c.layer.id ? 'active' : ''}">${esc(l.title)}</button>`)
      .join('');
    const scopeBtn = el.querySelector('[data-act="scope"]');
    scopeBtn.textContent = scoped && getFocus() !== 'in' ? `In ${focusName}` : 'All India';
    scopeBtn.disabled = getFocus() === 'in';
    const shown = c.rows.slice(0, LIMIT);
    el.querySelector('.table-count').textContent =
      c.rows.length > LIMIT ? `Showing ${fmt.format(LIMIT)} of ${fmt.format(c.rows.length)} rows` : `${fmt.format(c.rows.length)} ${c.rows.length === 1 ? 'row' : 'rows'}`;
    const head = c.cols
      .map((col) => `<th data-col="${esc(col.key)}" class="${col.num ? 'num' : ''}">${esc(col.title)}${c.sortedBy === col.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`)
      .join('');
    // Numeric cells get a bar so values compare at a glance
    const max = new Map(c.cols.filter((col) => col.num).map((col) => [col.key, Math.max(0, ...shown.map((r) => Number(col.get(r)) || 0))]));
    const body = shown
      .map((r, i) => {
        const cells = c.cols.map((col, j) => {
          const v = col.get(r);
          if (col.link) return `<td class="link">${v ? `<a href="${esc(v)}" target="_blank" rel="noopener" title="${esc(v)}">↗</a>` : ''}</td>`;
          if (col.num) {
            const pct = max.get(col.key) > 0 && !blank(v) ? Math.max(0, (Number(v) / max.get(col.key)) * 100) : 0;
            return `<td class="num"><span class="cell-bar" style="width:${pct.toFixed(1)}%"></span><span class="cell-num">${blank(v) ? '' : fmt.format(v)}</span></td>`;
          }
          return `<td class="${j === 0 ? 'first' : ''}" title="${esc(v)}">${blank(v) ? '<span class="nil">—</span>' : esc(v)}</td>`;
        });
        return `<tr data-i="${i}">${cells.join('')}</tr>`;
      })
      .join('');
    el.querySelector('.table-body').innerHTML = c.rows.length
      ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      : `<div class="table-empty">No rows${filter ? ' match the filter' : ` in ${esc(focusName)}`}.</div>`;
    el._rows = shown;
    el._kind = c.d.type;
  }

  function toCsv() {
    const c = current();
    if (!c) return;
    const cols = c.cols.filter((col) => !col.link || c.d.type === 'points');
    const cell = (v) => (blank(v) ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [cols.map((col) => cell(col.link ? 'url' : col.title)).join(',')];
    for (const r of c.rows) lines.push(cols.map((col) => cell(col.get(r))).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `${c.layer.id}${scoped && getFocus() !== 'in' ? `-${region(getFocus()).name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Events
  el.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-layer]');
    if (tab) {
      layerId = tab.dataset.layer;
      sort = { col: null, dir: -1 };
      return render();
    }
    const th = e.target.closest('th[data-col]');
    if (th) {
      sort = sort.col === th.dataset.col ? { col: th.dataset.col, dir: -sort.dir } : { col: th.dataset.col, dir: th.classList.contains('num') ? -1 : 1 };
      return render();
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') return api.close();
    if (act === 'scope') {
      scoped = !scoped;
      return render();
    }
    if (act === 'csv') return toCsv();
    const tr = e.target.closest('tr[data-i]');
    if (tr && !e.target.closest('a')) {
      el.querySelectorAll('tr.selected').forEach((x) => x.classList.remove('selected'));
      tr.classList.add('selected');
      const row = el._rows[Number(tr.dataset.i)];
      if (el._kind === 'points') onPoint(row);
      else onRegion(row.id);
    }
  });
  el.querySelector('.table-filter').addEventListener('input', (e) => {
    filter = e.target.value.trim();
    render();
  });

  // Drag the top edge to resize
  const grip = el.querySelector('.table-grip');
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    const stage = el.parentElement;
    const move = (ev) => {
      const h = Math.min(stage.clientHeight - 80, Math.max(140, stage.getBoundingClientRect().bottom - ev.clientY));
      stage.style.setProperty('--table-h', `${h}px`);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      save('maps.tableHeight', getComputedStyle(stage).getPropertyValue('--table-h').trim());
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
  });

  const api = {
    open(id) {
      if (id) layerId = id;
      const was = el.hidden;
      el.hidden = false;
      if (was) onToggle?.(el.offsetHeight);
      el.parentElement.classList.add('with-table');
      save('maps.tableOpen', '1');
      render();
    },
    close() {
      if (!el.hidden) onToggle?.(-el.offsetHeight);
      el.hidden = true;
      el.parentElement.classList.remove('with-table');
      save('maps.tableOpen', '');
    },
    toggle(id) {
      if (el.hidden || (id && id !== layerId)) api.open(id);
      else api.close();
    },
    render,
    restore() {
      const h = load('maps.tableHeight');
      if (h) el.parentElement.style.setProperty('--table-h', h);
      if (load('maps.tableOpen')) api.open();
    },
  };
  return api;
}

export function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
