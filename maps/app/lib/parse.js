// Reads a data file's contents into plain records: CSV/TSV, JSON (array of objects or GeoJSON), JSON Lines.
// Each record keeps its source line in __line; GeoJSON points carry their [lng, lat] in __coords.
// The file name only picks the format; without a known extension the format is guessed from the text.

const extOf = (name) => (/\.[a-z0-9]+$/i.exec(String(name || ''))?.[0] || '').toLowerCase();

// input: the file's text, or rows already parsed (an array of objects or a GeoJSON object)
export function parseData(input, name) {
  if (input != null && typeof input === 'object') return fromJson(input);
  if (typeof input !== 'string') throw new Error("rows must be the file's text or an array of objects");
  const text = input.replace(/^\uFEFF/, '');
  let ext = extOf(name);
  if (!['.csv', '.tsv', '.txt', '.json', '.geojson', '.jsonl', '.ndjson'].includes(ext)) {
    if (ext && name !== 'inline') throw new Error(`Unsupported file type "${ext}" (use .csv, .tsv, .json, .geojson or .jsonl)`);
    const head = text.trimStart();
    ext = head.startsWith('[') ? '.json' : head.startsWith('{') ? (/^\{[^\n]*\}\s*\r?\n\s*\{/.test(head) ? '.jsonl' : '.json') : '.csv';
  }
  if (ext === '.jsonl' || ext === '.ndjson') return parseJsonLines(text);
  if (ext === '.json' || ext === '.geojson') return parseJson(text);
  return parseCsv(text, ext === '.tsv' ? '\t' : null);
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
  return fromJson(data);
}

function fromJson(data) {
  if (data?.type === 'FeatureCollection') return data.features.flatMap(fromFeature);
  if (data?.type === 'Feature') return fromFeature(data, 0);
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.rows) ? data.rows : null;
  if (!rows) throw new Error('JSON must be an array of objects or a GeoJSON FeatureCollection');
  return rows.map((r, i) => ({ ...r, __line: i + 1 }));
}

function fromFeature(f, i) {
  const props = { ...(f.properties || {}), __line: i + 1 };
  const g = f.geometry;
  if (g?.type === 'Point') return [{ ...props, __coords: g.coordinates.slice(0, 2) }];
  if (g?.type === 'MultiPoint') return g.coordinates.map((c) => ({ ...props, __coords: c.slice(0, 2) }));
  return [props];
}

function parseJsonLines(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push({ ...JSON.parse(line), __line: i + 1 });
    } catch {
      out.push({ __line: i + 1, __error: 'invalid JSON' });
    }
  });
  return out;
}

export function parseCsv(text, delimiter) {
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const d = delimiter || ([',', '\t', ';'].map((c) => [c, firstLine.split(c).length]).sort((a, b) => b[1] - a[1])[0][0]);
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"' && field === '') quoted = true;
    else if (c === d) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push({ cells: row, line: rowLine });
      row = [];
      field = '';
      rowLine = ++line;
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ cells: row, line: rowLine });
  }
  const [head, ...body] = rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!head) return [];
  const names = head.cells.map((h) => h.trim());
  return body.map(({ cells, line }) => {
    const rec = { __line: line };
    names.forEach((n, i) => {
      if (n) rec[n] = (cells[i] ?? '').trim();
    });
    return rec;
  });
}
