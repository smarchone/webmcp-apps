// Builds the boundary files the map uses from Bharatlas's LGD layers (CC0).
//
//   npm run build:boundaries            downloads ~400 MB into .cache/ once, writes data/india/
//
// Output (data/india/):
//   states.geojson, districts.geojson        simplified, with id/name/parent properties
//   subdistricts/<state_code>.geojson        one file per state, loaded on demand
//   regions.json                             index of every region: id, name, level, parent, label point, bbox
//
// States and the country outline are dissolved from the simplified districts, so their edges line up exactly.
import fs from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'data', 'india');
const TMP = path.join(CACHE, 'build');

const SOURCE = 'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev/admin';
const RAW = {
  districts: `${SOURCE}/districts/LGD_Districts.geojson`,
  subdistricts: `${SOURCE}/subdistricts/LGD_Subdistricts.geojson`,
};

// LGD state codes -> display names (the source has upper-case names)
const STATES = {
  1: 'Jammu and Kashmir', 2: 'Himachal Pradesh', 3: 'Punjab', 4: 'Chandigarh', 5: 'Uttarakhand', 6: 'Haryana',
  7: 'Delhi', 8: 'Rajasthan', 9: 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland',
  14: 'Manipur', 15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal', 20: 'Jharkhand',
  21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat', 27: 'Maharashtra', 28: 'Andhra Pradesh',
  29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry',
  35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Ladakh', 38: 'Dadra and Nagar Haveli and Daman and Diu',
};

async function download(name, url) {
  const file = path.join(CACHE, `${name}.geojson`);
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
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(\-.])([a-z])/g, (_, a, b) => a + b.toUpperCase());
// The source mixes cases ("TIRUPPAR SOUTH") and leaves some names blank
const displayName = (s, fallback) => {
  const t = tidy(s).replace(/\s+district$/i, '');
  if (!t) return fallback;
  return t === t.toUpperCase() ? titleCase(t) : t;
};

// A few source polygons have code 0 (no LGD code) or share a code across districts; give each a stable unique id
function uniqueIds(level) {
  const used = new Set();
  return (code, parentCode, name) => {
    let key = code ? String(code) : `x${parentCode}-${tidy(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unnamed'}`;
    if (used.has(key)) key = `${key}~${parentCode}`;
    for (let n = 2; used.has(key); n++) key = key.replace(/(\.\d+)?$/, `.${n}`);
    used.add(key);
    return `in:${level}:${key}`;
  };
}

function bbox(geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) for (const [x, y] of poly[0]) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n].map((v) => +v.toFixed(4));
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'subdistricts'), { recursive: true });

  const districtsRaw = await download('districts', RAW.districts);
  const subdistrictsRaw = await download('subdistricts', RAW.subdistricts);
  const regions = [];

  // Districts, then states and country dissolved from them
  console.log('Simplifying districts');
  await run(
    `-i "${districtsRaw}" -filter-fields dist_lgd,state_lgd,dtname ` +
      `-simplify weighted interval=300 keep-shapes -clean ` +
      `-o "${TMP}/districts.geojson" precision=0.0001 ` +
      `-points inner -o "${TMP}/districts.points.geojson" precision=0.0001`
  );
  await run(
    `-i "${TMP}/districts.geojson" -dissolve state_lgd -o "${TMP}/states.geojson" precision=0.0001 ` +
      `-points inner -o "${TMP}/states.points.geojson" precision=0.0001`
  );
  await run(`-i "${TMP}/states.geojson" -dissolve -o "${TMP}/country.geojson" geojson-type=FeatureCollection precision=0.0001`);

  const country = await readJSON(`${TMP}/country.geojson`);
  const countryFeature = country.features[0];
  countryFeature.properties = { id: 'in', level: 'country', name: 'India' };
  regions.push({ id: 'in', level: 'country', name: 'India', parent: null, label: [78.9, 22.5], bbox: bbox(countryFeature.geometry) });
  await writeFile(path.join(OUT, 'country.geojson'), JSON.stringify(country));

  const states = await readJSON(`${TMP}/states.geojson`);
  const statePoints = (await readJSON(`${TMP}/states.points.geojson`)).features;
  states.features.forEach((f, i) => {
    const code = f.properties.state_lgd;
    const name = STATES[code] || `State ${code}`;
    const id = `in:state:${code}`;
    f.properties = { id, level: 'state', name, code, parent: 'in' };
    regions.push({ id, level: 'state', name, code, parent: 'in', label: statePoints[i]?.geometry?.coordinates ?? null, bbox: bbox(f.geometry) });
  });
  await writeFile(path.join(OUT, 'states.geojson'), JSON.stringify(states));

  const districts = await readJSON(`${TMP}/districts.geojson`);
  const districtPoints = (await readJSON(`${TMP}/districts.points.geojson`)).features;
  const districtId = uniqueIds('district');
  districts.features.forEach((f, i) => {
    const { dist_lgd: code, state_lgd: state, dtname } = f.properties;
    const id = districtId(code, state, dtname);
    const parent = `in:state:${state}`;
    const name = displayName(dtname, 'Unnamed district');
    f.properties = { id, level: 'district', name, code, parent, state: parent };
    regions.push({ id, level: 'district', name, code, parent, state: parent, label: districtPoints[i]?.geometry?.coordinates ?? null, bbox: bbox(f.geometry) });
  });
  await writeFile(path.join(OUT, 'districts.geojson'), JSON.stringify(districts));

  // Sub-districts, split per state so the page only loads the state it's looking at
  console.log('Simplifying sub-districts');
  await run(
    `-i "${subdistrictsRaw}" -filter-fields subdt_lgd,dist_lgd,state_lgd,sdtname ` +
      `-simplify weighted interval=120 keep-shapes -clean ` +
      `-o "${TMP}/subdistricts.geojson" precision=0.0001 ` +
      `-points inner -o "${TMP}/subdistricts.points.geojson" precision=0.0001`
  );
  const subs = await readJSON(`${TMP}/subdistricts.geojson`);
  const subPoints = (await readJSON(`${TMP}/subdistricts.points.geojson`)).features;
  const byState = new Map();
  const subId = uniqueIds('subdistrict');
  const districtIds = new Set(regions.filter((r) => r.level === 'district').map((r) => r.id));
  subs.features.forEach((f, i) => {
    const { subdt_lgd: code, dist_lgd: dist, state_lgd: state, sdtname } = f.properties;
    const id = subId(code, dist, sdtname);
    const stateId = `in:state:${state}`;
    const parent = districtIds.has(`in:district:${dist}`) ? `in:district:${dist}` : stateId;
    const name = displayName(sdtname, 'Unnamed sub-district');
    f.properties = { id, level: 'subdistrict', name, code, parent, state: stateId };
    regions.push({ id, level: 'subdistrict', name, code, parent, state: stateId, label: subPoints[i]?.geometry?.coordinates ?? null, bbox: bbox(f.geometry) });
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state).push(f);
  });
  for (const [state, features] of byState) {
    await writeFile(path.join(OUT, 'subdistricts', `${state}.geojson`), JSON.stringify({ type: 'FeatureCollection', features }));
  }

  await writeFile(
    path.join(OUT, 'regions.json'),
    JSON.stringify({
      source: {
        name: 'Local Government Directory (LGD), via Bharatlas',
        url: 'https://bharatlas.com',
        licence: 'CC0-1.0',
        vintage: '2024',
      },
      regions,
    })
  );
  await rm(TMP, { recursive: true, force: true });

  const count = (level) => regions.filter((r) => r.level === level).length;
  console.log(`Wrote ${count('state')} states, ${count('district')} districts, ${count('subdistrict')} sub-districts to ${path.relative(ROOT, OUT)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
