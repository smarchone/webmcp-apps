// The world's countries and their states / provinces, with India's districts and sub-districts below its states:
// world -> country -> state -> district -> sub-district.
// Looks regions up by id, LGD code or (fuzzy) name, and finds which regions contain a point.
// Runs on the boundary files the page loads; a country's states (outside India) and an Indian state's
// sub-districts are fetched the first time they're needed.

export const LEVELS = ['world', 'country', 'state', 'district', 'subdistrict'];

// The world index (Natural Earth) and India's (LGD) as one: India's own entry hangs off the world
export function combineRegions(world, india) {
  const regions = [...world.regions.filter((r) => r.id !== 'in'), ...india.regions.map((r) => (r.id === 'in' ? { ...r, parent: 'world' } : r))];
  return { source: [india.source, world.source], regions };
}

// Old or common names -> the names LGD uses (applied word by word to queries)
const ALIASES = {
  bangalore: 'bengaluru', bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai', gurgaon: 'gurugram',
  orissa: 'odisha', pondicherry: 'puducherry', trivandrum: 'thiruvananthapuram', mysore: 'mysuru', poona: 'pune',
  baroda: 'vadodara', allahabad: 'prayagraj', cochin: 'ernakulam', kochi: 'ernakulam', belgaum: 'belagavi',
  mangalore: 'dakshina kannada', mangaluru: 'dakshina kannada', calicut: 'kozhikode', uttaranchal: 'uttarakhand',
  noida: 'gautam buddha nagar', 'greater noida': 'gautam buddha nagar', secunderabad: 'hyderabad',
  vizag: 'visakhapatnam', benares: 'varanasi', banaras: 'varanasi', hubli: 'dharwad', shimoga: 'shivamogga',
  gulbarga: 'kalaburagi', bellary: 'ballari', tumkur: 'tumakuru', ooty: 'nilgiris', nct: 'delhi',
  metropolitan: 'metro', 'new delhi': 'new delhi', 'j and k': 'jammu and kashmir', jk: 'jammu and kashmir', up: 'uttar pradesh',
  mp: 'madhya pradesh', ap: 'andhra pradesh', tn: 'tamil nadu', wb: 'west bengal',
  uk: 'united kingdom', britain: 'united kingdom', uae: 'united arab emirates', burma: 'myanmar', ceylon: 'sri lanka',
};
const SUFFIXES = /\b(district|dist|distt|taluk|taluka|tehsil|tahsil|mandal|subdivision|sub division|city|urban district)$/;

export function norm(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Whole names that mean one region in everyday use ("Bangalore" is the urban district, not the rural one)
const PLACES = {
  bangalore: 'bengaluru urban', bengaluru: 'bengaluru urban', ahmedabad: 'ahmadabad',
  // Merged into one UT in 2020
  'daman and diu': 'dadra and nagar haveli and daman and diu', 'dadra and nagar haveli': 'dadra and nagar haveli and daman and diu',
  dnh: 'dadra and nagar haveli and daman and diu', 'nct of delhi': 'delhi', 'national capital territory of delhi': 'delhi',
};

function key(s) {
  let k = norm(s).replace(SUFFIXES, '').trim();
  if (PLACES[k]) return PLACES[k];
  if (ALIASES[k]) return ALIASES[k];
  return k
    .split(' ')
    .map((w) => ALIASES[w] || w)
    .join(' ');
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function score(q, name) {
  if (!q || !name) return 0;
  if (q === name) return 1;
  if (name.startsWith(q + ' ')) return 0.9; // "bengaluru" -> "bengaluru urban"
  if (q.startsWith(name + ' ')) return 0.82;
  if (name.length >= 4 && q.length >= 4) {
    const d = levenshtein(q, name);
    const sim = 1 - d / Math.max(q.length, name.length);
    if (sim >= 0.8) return 0.6 * sim + 0.35; // spelling variants: "tiruppur" / "tirupur"
  }
  if (q.length >= 4 && (' ' + name + ' ').includes(' ' + q + ' ')) return 0.7;
  return 0;
}

// ---------- Geometry ----------

function prepare(feature) {
  const g = feature.geometry;
  if (!g) return null;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return { id: feature.properties.id, polys, bbox: [w, s, e, n] };
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Distance (km, approximate) from a point to a shape's outline; 0 when inside
function distanceKm(shape, x, y) {
  if (contains(shape, x, y)) return 0;
  const k = Math.cos((y * Math.PI) / 180);
  let best = Infinity;
  for (const poly of shape.polys) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1];
      const [x2, y2] = ring[i];
      const dx = (x2 - x1) * k, dy = y2 - y1;
      const px = (x - x1) * k, py = y - y1;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d < best) best = d;
    }
  }
  return best * 111.32;
}

const SNAP_KM = 3; // simplified coastlines and borders can leave real points just outside

function nearest(shapes, x, y) {
  const inside = shapes.find((s) => contains(s, x, y));
  if (inside) return inside;
  const pad = SNAP_KM / 100;
  let best = null, bestD = SNAP_KM;
  for (const s of shapes) {
    const [w, so, e, n] = s.bbox;
    if (x < w - pad || x > e + pad || y < so - pad || y > n + pad) continue;
    const d = distanceKm(s, x, y);
    if (d <= bestD) [best, bestD] = [s, d];
  }
  return best;
}

function contains(shape, x, y) {
  const [w, s, e, n] = shape.bbox;
  if (x < w || x > e || y < s || y > n) return false;
  for (const poly of shape.polys) {
    if (!inRing(x, y, poly[0])) continue;
    let hole = false;
    for (let i = 1; i < poly.length && !hole; i++) hole = inRing(x, y, poly[i]);
    if (!hole) return true;
  }
  return false;
}

// Ties between equally good matches go to India's regions: "Punjab" is the Indian state unless a country column
// says otherwise. Big enough to break a tie (see resolve), too small to beat a better match.
const INDIA_FIRST = 0.006;
const inIndia = (id) => id === 'in' || id.startsWith('in:');

// ---------- Index ----------

export class RegionIndex {
  // regions: combineRegions(world, india); countries, states (India's), districts: the GeoJSON files;
  // worldStates(countryId): resolves to a country's state FeatureCollection (or null);
  // subdistricts(code): resolves to an Indian state's sub-district FeatureCollection (or null)
  constructor({ regions, countries, states, districts, worldStates, subdistricts }) {
    this.loadWorldStates = worldStates;
    this.loadSubdistricts = subdistricts;
    this.byId = new Map();
    this.kids = new Map();
    this.byCode = new Map(); // `${level}:${code}` -> region (India's LGD codes)
    this.shapes = { country: [], district: new Map() }; // district shapes grouped by state
    this.stateShapes = new Map(); // country id -> Promise<state shapes>
    this.subShapes = new Map(); // state id -> Promise<Map(district id -> shapes)>
    this.source = regions.source;
    for (const r of regions.regions) {
      r.keys = [...new Set([r.name, ...(r.alt || [])].map(key).filter(Boolean))];
      this.byId.set(r.id, r);
      if (r.code && inIndia(r.id)) this.byCode.set(`${r.level}:${r.code}`, r);
      if (r.parent) {
        if (!this.kids.has(r.parent)) this.kids.set(r.parent, []);
        this.kids.get(r.parent).push(r);
      }
    }
    this.shapes.country = countries.features.map(prepare).filter(Boolean);
    this.stateShapes.set('in', Promise.resolve(states.features.map(prepare).filter(Boolean)));
    for (const f of districts.features) {
      const shape = prepare(f);
      if (!shape) continue;
      const st = f.properties.state;
      if (!this.shapes.district.has(st)) this.shapes.district.set(st, []);
      this.shapes.district.get(st).push(shape);
    }
  }

  get(id) {
    const r = this.byId.get(id);
    return r ? this.public(r) : null;
  }

  public(r) {
    return { id: r.id, name: r.name, level: r.level, code: r.code ?? null, parent: r.parent, label: r.label, bbox: r.bbox };
  }

  // { world, country, state, district, subdistrict } ids above (and including) a region
  chain(id) {
    const out = {};
    for (let r = this.byId.get(id); r; r = this.byId.get(r.parent)) out[r.level] = r.id;
    return out;
  }

  path(id) {
    const names = [];
    for (let r = this.byId.get(this.byId.get(id)?.parent); r && r.level !== 'world'; r = this.byId.get(r.parent)) names.push(r.name);
    return names.join(', ');
  }

  children(parentId, level) {
    let list = this.kids.get(parentId) || [];
    // Asking a state for its sub-districts skips the district level (and the world for states, the countries)
    const depth = LEVELS.indexOf(level);
    while (level && list.length && LEVELS.indexOf(list[0].level) < depth) list = list.flatMap((c) => this.kids.get(c.id) || []);
    if (level) list = list.filter((r) => r.level === level);
    return list.map((r) => ({ id: r.id, name: r.name, level: r.level })).sort((a, b) => a.name.localeCompare(b.name));
  }

  find(query, { level, within, limit = 5 } = {}) {
    const q = key(query);
    if (!q) return [];
    const withinId = within ? this.resolveId(within) : null;
    const results = [];
    for (const r of this.byId.values()) {
      if (level && r.level !== level) continue;
      if (withinId && withinId !== r.id && !Object.values(this.chain(r.id)).includes(withinId)) continue;
      let s = 0;
      for (const k of r.keys) s = Math.max(s, score(q, k));
      if (s <= 0) continue;
      // Ties go to the bigger region: "Hyderabad" the district before the sub-district
      results.push({ r, s: s + (LEVELS.length - LEVELS.indexOf(r.level)) * 0.001 + (inIndia(r.id) ? INDIA_FIRST : 0) });
    }
    results.sort((a, b) => b.s - a.s);
    return results.slice(0, limit).map(({ r, s }) => ({ ...this.public(r), in: this.path(r.id), score: +s.toFixed(2) }));
  }

  resolveId(ref) {
    if (this.byId.has(ref)) return ref;
    return this.find(ref, { limit: 1 })[0]?.id ?? null;
  }

  // One region for a reference in a data file: id, LGD code (with level) or name, optionally inside a named
  // country and / or state. Returns { region } or { error }.
  resolve(ref, { level, state, country } = {}) {
    const raw = String(ref ?? '').trim();
    if (!raw) return { error: 'empty region' };
    if (this.byId.has(raw)) return { region: this.get(raw) };
    if (/^\d+$/.test(raw) && level) {
      const r = this.byCode.get(`${level}:${Number(raw)}`);
      return r ? { region: this.public(r) } : { error: `no ${level} with LGD code ${raw}` };
    }
    let within;
    if (country) {
      within = this.find(String(country), { level: 'country', limit: 1 })[0];
      if (!within || within.score < 0.85) return { error: `unknown country "${country}"` };
    }
    if (state) {
      within = this.find(String(state), { level: 'state', within: within?.id, limit: 1 })[0];
      if (!within || within.score < 0.85) return { error: `unknown state "${state}"${country ? ` in ${country}` : ''}` };
    }
    const matches = this.find(raw, { level, within: within?.id, limit: 3 });
    const best = matches[0];
    if (!best || best.score < 0.85) return { error: `unknown ${level || 'region'} "${raw}"` };
    const rivals = matches.filter((m) => m.level === best.level && Math.abs(m.score - best.score) < 0.005);
    if (rivals.length > 1) {
      return { error: `"${raw}" is ambiguous (${rivals.map((m) => `${m.name}, ${m.in}`).join(' / ')}); add a state column or use a region id` };
    }
    return { region: best };
  }

  // Which country / state / district / sub-district contains a point (districts and below in India only)
  async locate(lng, lat) {
    const out = {};
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return out;
    const country = nearest(this.shapes.country, lng, lat);
    if (!country) return out;
    out.world = 'world';
    out.country = country.id;
    const state = nearest(await this.statesOf(country.id), lng, lat);
    if (!state) return out;
    out.state = state.id;
    if (country.id !== 'in') return out;
    const district = nearest(this.shapes.district.get(state.id) || [], lng, lat);
    if (!district) return out;
    out.district = district.id;
    const sub = nearest((await this.subdistrictShapes(state.id)).get(district.id) || [], lng, lat);
    if (sub) out.subdistrict = sub.id;
    return out;
  }

  statesOf(countryId) {
    if (!this.stateShapes.has(countryId)) {
      const load = Promise.resolve(this.loadWorldStates?.(countryId)).then((fc) => (fc?.features || []).map(prepare).filter(Boolean));
      this.stateShapes.set(countryId, load);
    }
    return this.stateShapes.get(countryId);
  }

  subdistrictShapes(stateId) {
    if (!this.subShapes.has(stateId)) {
      const code = this.byId.get(stateId)?.code;
      const load = (code == null ? Promise.resolve(null) : this.loadSubdistricts(code)).then((fc) => {
        const byDistrict = new Map();
        for (const f of fc?.features || []) {
          const shape = prepare(f);
          if (!shape) continue;
          const d = f.properties.parent;
          if (!byDistrict.has(d)) byDistrict.set(d, []);
          byDistrict.get(d).push(shape);
        }
        return byDistrict;
      });
      this.subShapes.set(stateId, load);
    }
    return this.subShapes.get(stateId);
  }
}
