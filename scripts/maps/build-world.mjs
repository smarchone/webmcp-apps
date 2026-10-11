// Builds the world boundary files the map uses from Natural Earth (public domain).
//
//   npm run build:world            downloads ~55 MB into .cache/ once, writes apps/maps/data/world/
//
// Output (apps/maps/data/world/, served with the page):
//   countries.geojson                 every country, simplified, with id/name/code properties
//   states/<country id>.geojson       one file per country with its states / provinces (admin-1), loaded on demand
//   regions.json                      index of the world, its countries and their states: id, name, alt names, label, bbox
// It also renames the cache in apps/maps/sw.js, so browsers that cached the old files fetch the new ones.
//
// India is not taken from Natural Earth: its outline comes from the LGD boundaries in apps/maps/data/india/ (built by
// `npm run build:boundaries`), and everything else is cut away where it overlaps that outline, so India's states,
// districts and sub-districts line up with the country they sit in. Countries use Natural Earth's India point of view.
import fs from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const CACHE = path.join(ROOT, '.cache');
const APP = path.join(ROOT, '..', '..', 'apps', 'maps');
const OUT = path.join(APP, 'data', 'world');
const INDIA = path.join(APP, 'data', 'india', 'country.geojson');
const TMP = path.join(CACHE, 'build-world');
const SERVICE_WORKER = path.join(APP, 'sw.js');

const VERSION = 'v5.1.2';
const SOURCE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${VERSION}/geojson`;
const RAW = {
  countries: `${SOURCE}/ne_10m_admin_0_countries_ind.geojson`,
  states: `${SOURCE}/ne_10m_admin_1_states_provinces.geojson`,
};

// States whose country Natural Earth's India view folds into another one
const FOLDED = { KOS: 'SRB', SOL: 'SOM', SAH: 'MAR', CYN: 'CYP', KAB: 'KAZ', KAS: 'PAK' };

async function download(name, url) {
  const file = path.join(CACHE, `${name}-${VERSION}.geojson`);
  if (fs.existsSync(file)) return file;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${file}.part`));
  fs.renameSync(`${file}.part`, file);
  return file;
}

const run = (cmd) => mapshaper.runCommands(cmd);
const readJSON = async (f) => JSON.parse(await readFile(f, 'utf8'));
const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const round = (v) => +v.toFixed(4);

function bounds(polys) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(a / 2);
}

// The box the map flies to: the main landmass and the big pieces near it, so the US frames the lower 48 and
// Alaska rather than the whole Pacific, and France its mainland rather than French Guiana too
function bbox(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const sized = polys.map((p) => ({ p, a: area(p[0]) })).sort((x, y) => y.a - x.a);
  let box = bounds(sized.filter((x) => x.a >= sized[0].a * 0.2).map((x) => x.p));
  if (box[2] - box[0] > 180) box = bounds([sized[0].p]);
  return box.map(round);
}

// Other names a region goes by, for matching data files; the display name is left out
function alts(name, list) {
  const seen = new Set([tidy(name).toLowerCase()]);
  const out = [];
  for (const raw of list.flatMap((s) => String(s ?? '').split('|'))) {
    const s = tidy(raw);
    if (!s || s === '-99' || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

async function main() {
  if (!fs.existsSync(INDIA)) throw new Error(`${INDIA} is missing: run npm run build:boundaries first`);
  await mkdir(CACHE, { recursive: true });
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'states'), { recursive: true });

  const countriesRaw = await download('ne-countries-ind', RAW.countries);
  const statesRaw = await download('ne-states', RAW.states);

  // Countries: simplified, with India's own outline cut out of its neighbours, then India added back from LGD
  console.log('Simplifying countries');
  await run(
    `-i "${countriesRaw}" -filter "ADM0_A3 !== 'IND'" ` +
      `-filter-fields ADM0_A3,ISO_A2_EH,ISO_A3_EH,NAME,NAME_LONG,ADMIN,FORMAL_EN,NAME_EN,LABEL_X,LABEL_Y ` +
      `-simplify weighted interval=2500 keep-shapes -clean ` +
      `-erase "${INDIA}" -filter-slivers min-area=0.01km2 -filter "!this.isNull" ` +
      `-o "${TMP}/countries.geojson" precision=0.001`
  );
  console.log('Simplifying states');
  await run(
    `-i "${statesRaw}" -filter "adm0_a3 !== 'IND'" ` +
      `-filter-fields adm0_a3,adm1_code,iso_3166_2,name,name_en,name_alt,type_en,longitude,latitude ` +
      `-simplify weighted interval=800 keep-shapes -clean ` +
      `-erase "${INDIA}" -filter-slivers min-area=0.01km2 -filter "!this.isNull" ` +
      `-o "${TMP}/states.geojson" precision=0.001`
  );

  const regions = [{ id: 'world', level: 'world', name: 'World', parent: null, label: [20, 20], bbox: [-180, -58, 180, 84] }];

  // Ids: lower-case ISO 3166 alpha-2 like India's "in", or the Natural Earth code for places without their own
  const countries = await readJSON(`${TMP}/countries.geojson`);
  const idOf = new Map(); // ADM0_A3 -> id
  const taken = new Set(['in', 'world']);
  const owns = (p) => p.ISO_A2_EH !== '-99' && p.ISO_A3_EH === p.ADM0_A3;
  for (const pass of [true, false]) {
    for (const { properties: p } of countries.features) {
      if (idOf.has(p.ADM0_A3) || owns(p) !== pass) continue;
      let id = p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH.toLowerCase() : p.ADM0_A3.toLowerCase();
      if (taken.has(id)) id = p.ADM0_A3.toLowerCase();
      taken.add(id);
      idOf.set(p.ADM0_A3, id);
    }
  }
  idOf.set('IND', 'in');
  for (const f of countries.features) {
    const p = f.properties;
    const id = idOf.get(p.ADM0_A3);
    const code = p.ISO_A3_EH !== '-99' ? p.ISO_A3_EH : p.ADM0_A3;
    const name = tidy(p.NAME_LONG || p.NAME);
    const alt = alts(name, [p.NAME, p.ADMIN, p.FORMAL_EN, p.NAME_EN, owns(p) ? p.ISO_A2_EH : '', owns(p) ? code : '']);
    f.properties = { id, level: 'country', name, code, parent: 'world' };
    regions.push({ id, level: 'country', name, code, parent: 'world', alt, label: [round(p.LABEL_X), round(p.LABEL_Y)], bbox: bbox(f.geometry) });
  }
  const india = await readJSON(INDIA);
  countries.features.push({ ...india.features[0], properties: { id: 'in', level: 'country', name: 'India', code: 'IND', parent: 'world' } });
  await writeFile(path.join(OUT, 'countries.geojson'), JSON.stringify(countries));

  // States, split per country so the page only loads the country it's looking at
  const states = await readJSON(`${TMP}/states.geojson`);
  const byCountry = new Map();
  const used = new Set();
  let unplaced = 0;
  for (const f of states.features) {
    const p = f.properties;
    const country = idOf.get(FOLDED[p.adm0_a3] || p.adm0_a3);
    if (!country) {
      unplaced++;
      continue;
    }
    const iso = tidy(p.iso_3166_2);
    let key = /^[A-Z]{2}-[A-Z0-9]+$/.test(iso) ? iso : tidy(p.adm1_code);
    if (used.has(`${country}:${key}`)) key = tidy(p.adm1_code);
    used.add(`${country}:${key}`);
    const id = `${country}:state:${key}`;
    const name = tidy(p.name_en || p.name) || key;
    const alt = alts(name, [p.name, p.name_alt, /^[A-Z]{2}-[A-Z0-9]+$/.test(iso) ? iso : '']);
    f.properties = { id, level: 'state', name, code: key, parent: country };
    const label = Number.isFinite(p.longitude) && Number.isFinite(p.latitude) ? [round(p.longitude), round(p.latitude)] : null;
    regions.push({ id, level: 'state', name, code: key, parent: country, kind: tidy(p.type_en) || undefined, alt, label, bbox: bbox(f.geometry) });
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push(f);
  }
  for (const [country, features] of byCountry) {
    await writeFile(path.join(OUT, 'states', `${country}.geojson`), JSON.stringify({ type: 'FeatureCollection', features }));
  }
  for (const r of regions) if (!r.alt?.length) delete r.alt;

  await writeFile(
    path.join(OUT, 'regions.json'),
    JSON.stringify({
      source: { name: 'Natural Earth', url: 'https://www.naturalearthdata.com', licence: 'Public domain', vintage: VERSION },
      regions,
    })
  );
  await rm(TMP, { recursive: true, force: true });

  // New files need a new cache name, or browsers keep serving the copies they cached before
  const sw = await readFile(SERVICE_WORKER, 'utf8');
  await writeFile(SERVICE_WORKER, sw.replace(/const VERSION = '[^']*';/, `const VERSION = 'boundaries-${Date.now()}';`));

  const count = (level) => regions.filter((r) => r.level === level).length;
  console.log(`Wrote ${count('country')} countries and ${count('state')} states in ${byCountry.size} countries to ${path.relative(ROOT, OUT)}/` + (unplaced ? ` (${unplaced} states without a country skipped)` : ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
