// Gate the data-refresh pipeline: validate the freshly written data files BEFORE they're
// committed and served to clients off the CDN. The refresh job commits straight to main and a
// bot push doesn't re-trigger CI, so without this a half-written file or a Zillow/Freddie schema
// change could ship bad numbers (or NaN) to every visitor. Run after the fetch steps; a non-zero
// exit fails the run and blocks the commit. Pure Node, no deps.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const errors = [];
const fail = (msg) => errors.push(msg);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const inBand = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;
const isStr = (v) => typeof v === "string" && v.length > 0;

async function readJson(rel) {
  try {
    return JSON.parse(await readFile(join(ROOT, rel), "utf8"));
  } catch (e) {
    fail(`${rel}: unreadable or invalid JSON (${e.message})`);
    return null;
  }
}

function checkMarket(m) {
  if (!m || typeof m !== "object") return fail("market.json: not an object");
  if (!isStr(m.asOf)) fail("market.json: missing asOf");

  const mort = m.mortgage ?? {};
  if (!inBand(mort.rate30, 0.001, 0.25)) fail(`market.json: mortgage.rate30 out of band (${mort.rate30})`);
  if (!inBand(mort.rate15, 0.001, 0.25)) fail(`market.json: mortgage.rate15 out of band (${mort.rate15})`);
  if (mort.jumboSpread != null && !inBand(mort.jumboSpread, -0.05, 0.05))
    fail(`market.json: mortgage.jumboSpread out of band (${mort.jumboSpread})`);
  if (!isStr(mort.asOf)) fail("market.json: missing mortgage.asOf");

  const inf = m.inflation ?? {};
  if (!inBand(inf.rate, -0.1, 0.25)) fail(`market.json: inflation.rate out of band (${inf.rate})`);
  if (!isStr(inf.asOf)) fail("market.json: missing inflation.asOf");

  const app = m.appreciation ?? {};
  if (!inBand(app.rate1yr, -0.5, 0.5)) fail(`market.json: appreciation.rate1yr out of band (${app.rate1yr})`);
  if (!inBand(app.rate5yrCagr, -0.5, 0.5)) fail(`market.json: appreciation.rate5yrCagr out of band (${app.rate5yrCagr})`);
  if (!isStr(app.asOf)) fail("market.json: missing appreciation.asOf");

  const nat = m.national ?? {};
  if (!inBand(nat.homeValue, 10_000, 100_000_000)) fail(`market.json: national.homeValue out of band (${nat.homeValue})`);
  if (!inBand(nat.rent, 100, 1_000_000)) fail(`market.json: national.rent out of band (${nat.rent})`);
  if (!isStr(nat.asOf)) fail("market.json: missing national.asOf");
}

function checkLocations(locs) {
  if (!Array.isArray(locs)) return fail("locations.json: not an array");
  // A collapse to a handful means the metro join broke and everything fell back to national.
  if (locs.length < 50) fail(`locations.json: only ${locs.length} metros (expected 50+, join likely broke)`);
  if (!locs.some((l) => l && l.id === "united-states")) fail("locations.json: missing the national fallback entry");
  let bad = 0;
  for (const l of locs) {
    if (!l || !isStr(l.id) || !isStr(l.metro) || !isStr(l.state) || !inBand(l.homeValue, 1, 1e8) || !inBand(l.rent, 1, 1e6)) {
      bad++;
    }
  }
  if (bad > 0) fail(`locations.json: ${bad} entries with missing/out-of-band fields`);
}

function checkZips(zips) {
  if (!zips || typeof zips !== "object" || Array.isArray(zips)) return fail("zips.json: not a keyed object");
  const keys = Object.keys(zips);
  if (keys.length < 1000) fail(`zips.json: only ${keys.length} ZIPs (expected thousands)`);
}

const market = await readJson("src/data/market.json");
const locations = await readJson("src/data/locations.json");
const zips = await readJson("public/zips.json");
if (market) checkMarket(market);
if (locations) checkLocations(locations);
if (zips) checkZips(zips);

if (errors.length) {
  console.error("Data validation FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("Data validation passed: market.json, locations.json, zips.json all within sane bounds.");
