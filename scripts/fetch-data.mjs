#!/usr/bin/env node
// Fetches the freshest public US housing data and bakes it into JSON the
// frontend reads. Runs at build time (scheduled CI). There is no runtime
// server. ZERO npm dependencies: native fetch, native parsing, hand-rolled CSV.
//
// Robustness contract: every source is wrapped in its own try/catch. On any
// failure we log a [warn] line and keep the value already committed in the
// JSON, so one broken source can never break the build or zero-out data.
//
// Run: node scripts/fetch-data.mjs   (from repo root)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "src", "data");
const MARKET_PATH = join(DATA_DIR, "market.json");
const LOCATIONS_PATH = join(DATA_DIR, "locations.json");
const PROPERTY_TAX_PATH = join(DATA_DIR, "propertyTax.json");

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "buyorwhatever-data-fetch/1.0 (+https://github.com/)";

// ---------------------------------------------------------------------------
// Source URLs (verified live as of 2026-06). If one moves, update here.
// ---------------------------------------------------------------------------
const URLS = {
  pmms: "https://www.freddiemac.com/pmms/docs/PMMS_history.csv",
  bls: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  zhvi:
    "https://files.zillowstatic.com/research/public_csvs/zhvi/" +
    "Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
  zori:
    "https://files.zillowstatic.com/research/public_csvs/zori/" +
    "Metro_zori_uc_sfrcondomfr_sm_month.csv",
};

// Number of largest metros (by Zillow SizeRank) to emit in locations.json.
const MAX_METROS = 400;

// ---------------------------------------------------------------------------
// Property tax: effective rate on owner-occupied housing by state.
// Curated from Tax Foundation "Property Taxes by State" (2024 ACS data).
// Changes slowly, so no live fetch needed; baked straight into the output.
// ---------------------------------------------------------------------------
const PROPERTY_TAX = {
  _source:
    "Tax Foundation, effective property tax rate on owner-occupied housing (2024)",
  _asOf: "2024",
  AL: 0.0037,
  AK: 0.0094,
  AZ: 0.0048,
  AR: 0.0056,
  CA: 0.007,
  CO: 0.005,
  CT: 0.0154,
  DE: 0.0054,
  DC: 0.0057,
  FL: 0.0078,
  GA: 0.0079,
  HI: 0.0029,
  ID: 0.005,
  IL: 0.0188,
  IN: 0.0076,
  IA: 0.0133,
  KS: 0.0121,
  KY: 0.0074,
  LA: 0.0055,
  ME: 0.0098,
  MD: 0.0092,
  MA: 0.01,
  MI: 0.0119,
  MN: 0.01,
  MS: 0.0058,
  MO: 0.0089,
  MT: 0.0061,
  NE: 0.0144,
  NV: 0.005,
  NH: 0.015,
  NJ: 0.0188,
  NM: 0.0063,
  NY: 0.013,
  NC: 0.0066,
  ND: 0.0092,
  OH: 0.0136,
  OK: 0.0079,
  OR: 0.0081,
  PA: 0.0126,
  RI: 0.0112,
  SC: 0.0049,
  SD: 0.01,
  TN: 0.0052,
  TX: 0.014,
  UT: 0.0048,
  VT: 0.0151,
  VA: 0.0078,
  WA: 0.0075,
  WV: 0.0051,
  WI: 0.0132,
  WY: 0.0053,
};

// ---------------------------------------------------------------------------
// Defaults: used only when the committed JSON is missing AND the live fetch
// fails, so the output is always populated and valid. Recent real values.
// ---------------------------------------------------------------------------
const DEFAULT_MARKET = {
  asOf: "2026-06-12",
  mortgage: { rate30: 0.0652, rate15: 0.0584, asOf: "2026-06-11", source: "Freddie Mac PMMS" },
  inflation: { rate: 0.0425, asOf: "2026-05", source: "BLS CPI-U (CUUR0000SA0), YoY" },
  appreciation: {
    rate1yr: 0.03,
    rate5yrCagr: 0.04,
    asOf: "2026-04",
    source: "Zillow ZHVI (US), CAGR",
  },
  national: {
    homeValue: 368000,
    rent: 1930,
    asOf: "2026-04",
    source: "Zillow ZHVI/ZORI (US)",
  },
};

const DEFAULT_LOCATIONS = [
  {
    id: "united-states",
    metro: "United States",
    state: "US",
    homeValue: 368000,
    rent: 1930,
    appreciation5yr: 0.04,
  },
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonOr(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // Deep-clone the fallback so callers can mutate freely.
    return structuredClone(fallback);
  }
}

// Parse one CSV line into fields, honoring double-quoted fields that may
// contain commas and escaped ("") quotes. Hand-rolled, no deps.
function parseCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

// Split CSV text into rows (handles trailing \r, blank lines, BOM).
function parseCsv(text) {
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return clean
    .split("\n")
    .filter((l) => l.length > 0)
    .map(parseCsvLine);
}

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Annualized CAGR from start to end value over `months` months.
function cagr(startVal, endVal, months) {
  if (!(startVal > 0) || !(endVal > 0) || months <= 0) return null;
  const years = months / 12;
  return Math.pow(endVal / startVal, 1 / years) - 1;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// SOURCE 1: Freddie Mac PMMS, 30yr / 15yr fixed mortgage rates
// ---------------------------------------------------------------------------
// CSV header: date,pmms30,pmms30p,pmms15,pmms15p,...
//   pmms30 = 30yr FRM rate (%), pmms15 = 15yr FRM rate (%).
// Latest data row is the last non-empty one. Values are percents, so /100.
async function fetchMortgage(existing, summary) {
  try {
    const res = await fetchWithTimeout(URLS.pmms);
    const rows = parseCsv(await res.text());
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const iDate = header.indexOf("date");
    const i30 = header.indexOf("pmms30");
    const i15 = header.indexOf("pmms15");
    if (iDate < 0 || i30 < 0) throw new Error("expected PMMS columns not found");

    // Walk from the bottom for the last row with a usable 30yr value.
    let row = null;
    for (let r = rows.length - 1; r >= 1; r--) {
      const v = (rows[r][i30] || "").trim();
      if (v && !Number.isNaN(Number(v))) {
        row = rows[r];
        break;
      }
    }
    if (!row) throw new Error("no usable PMMS data row");

    const rate30 = round4(Number(row[i30]) / 100);
    const rawDate = (row[iDate] || "").trim();
    const asOf = normalizeUsDate(rawDate);

    const out = { ...existing, rate30, asOf, source: "Freddie Mac PMMS" };
    const v15 = i15 >= 0 ? (row[i15] || "").trim() : "";
    if (v15 && !Number.isNaN(Number(v15))) {
      out.rate15 = round4(Number(v15) / 100);
    } else if (existing.rate15 != null) {
      out.rate15 = existing.rate15; // keep prior 15yr if this row lacks it
    }

    summary.push(`mortgage: UPDATED rate30=${out.rate30} rate15=${out.rate15 ?? "n/a"} (${asOf})`);
    return out;
  } catch (err) {
    console.warn(`[warn] Freddie Mac PMMS failed: ${err.message}, keeping existing value`);
    summary.push(`mortgage: fell back (rate30=${existing.rate30})`);
    return existing;
  }
}

// "6/11/2026" -> "2026-06-11"
function normalizeUsDate(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return s;
  const [, mo, da, yr] = m;
  return `${yr}-${mo.padStart(2, "0")}-${da.padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// SOURCE 2: BLS CPI-U (CUUR0000SA0, NSA), trailing-12-month YoY inflation
// ---------------------------------------------------------------------------
async function fetchInflation(existing, summary) {
  try {
    const now = new Date();
    const thisYear = now.getUTCFullYear();
    const lastYear = thisYear - 1;
    const res = await fetchWithTimeout(URLS.bls, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seriesid: ["CUUR0000SA0"],
        startyear: String(lastYear),
        endyear: String(thisYear),
      }),
    });
    const json = await res.json();
    if (json.status !== "REQUEST_SUCCEEDED") {
      throw new Error(`BLS status ${json.status}: ${(json.message || []).join("; ")}`);
    }
    const data = json.Results?.series?.[0]?.data;
    if (!Array.isArray(data) || data.length === 0) throw new Error("no BLS data points");

    // Build a lookup of monthly index values keyed "YYYY-MM" (skip annual M13
    // and any unavailable "-" placeholders).
    const byMonth = new Map();
    for (const d of data) {
      if (d.period === "M13") continue;
      const val = Number(d.value);
      if (!Number.isFinite(val) || d.value === "-") continue;
      const mm = d.period.replace("M", "");
      byMonth.set(`${d.year}-${mm}`, val);
    }

    // Latest available month, then the same month one year prior.
    const latest = data.find(
      (d) => d.period !== "M13" && d.value !== "-" && Number.isFinite(Number(d.value)),
    );
    if (!latest) throw new Error("no usable latest CPI point");
    const mm = latest.period.replace("M", "");
    const latestKey = `${latest.year}-${mm}`;
    const yearAgoKey = `${Number(latest.year) - 1}-${mm}`;

    const cur = byMonth.get(latestKey);
    const prev = byMonth.get(yearAgoKey);
    if (!(cur > 0) || !(prev > 0)) {
      throw new Error(`missing CPI for ${latestKey} or ${yearAgoKey}`);
    }
    const rate = round4(cur / prev - 1);
    const asOf = latestKey;

    summary.push(`inflation: UPDATED rate=${rate} (${asOf})`);
    return { rate, asOf, source: "BLS CPI-U (CUUR0000SA0), YoY" };
  } catch (err) {
    console.warn(`[warn] BLS CPI-U failed: ${err.message}, keeping existing value`);
    summary.push(`inflation: fell back (rate=${existing.rate})`);
    return existing;
  }
}

// ---------------------------------------------------------------------------
// Zillow wide-CSV helpers (shared by ZHVI and ZORI)
// ---------------------------------------------------------------------------
// Columns: RegionID,SizeRank,RegionName,RegionType,StateName,<YYYY-MM-DD...>
function parseZillowWide(text) {
  const rows = parseCsv(text);
  const header = rows[0];
  const idx = {
    regionId: header.indexOf("RegionID"),
    sizeRank: header.indexOf("SizeRank"),
    regionName: header.indexOf("RegionName"),
    stateName: header.indexOf("StateName"),
  };
  // Date columns are everything matching YYYY-MM-DD, in order.
  const dateCols = [];
  for (let c = 0; c < header.length; c++) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(header[c])) dateCols.push({ col: c, date: header[c] });
  }
  return { rows, header, idx, dateCols };
}

// Latest non-empty value (and its date) for a parsed row.
function latestValue(row, dateCols) {
  for (let i = dateCols.length - 1; i >= 0; i--) {
    const raw = (row[dateCols[i].col] || "").trim();
    if (raw && !Number.isNaN(Number(raw))) {
      return { value: Number(raw), date: dateCols[i].date };
    }
  }
  return null;
}

// Value approximately `monthsBack` months before the latest, for CAGR.
// Walks to the nearest available column at/just-before the target index.
function valueMonthsBack(row, dateCols, latestIdxInfo, monthsBack) {
  const latestCol = latestIdxInfo.colIndex;
  const targetIdx = latestCol - monthsBack;
  for (let i = Math.min(targetIdx, dateCols.length - 1); i >= 0; i--) {
    const raw = (row[dateCols[i].col] || "").trim();
    if (raw && !Number.isNaN(Number(raw))) {
      return { value: Number(raw), monthsAgo: latestCol - i };
    }
  }
  return null;
}

// Find the index (within dateCols) of the latest non-empty value for a row.
function latestColIndex(row, dateCols) {
  for (let i = dateCols.length - 1; i >= 0; i--) {
    const raw = (row[dateCols[i].col] || "").trim();
    if (raw && !Number.isNaN(Number(raw))) return i;
  }
  return -1;
}

function stateFromRow(row, idx) {
  const st = (row[idx.stateName] || "").trim();
  if (/^[A-Z]{2}$/.test(st)) return st;
  // Fall back to parsing ", XX" suffix of RegionName (e.g. "New York, NY").
  const name = (row[idx.regionName] || "").trim();
  const m = name.match(/,\s*([A-Z]{2})\b/);
  return m ? m[1] : "";
}

// ---------------------------------------------------------------------------
// SOURCES 3+4: Zillow ZHVI (home values) + ZORI (rents) by metro.
// Builds locations.json (inner join on RegionName) and the national figures
// plus appreciation rates for market.json.
// ---------------------------------------------------------------------------
async function fetchZillow(existingMarket, existingLocations, summary) {
  // Returned values default to existing; we overwrite only what we compute.
  let national = existingMarket.national;
  let appreciation = existingMarket.appreciation;
  let locations = existingLocations;

  // -- ZHVI -----------------------------------------------------------------
  let zhvi = null;
  try {
    const res = await fetchWithTimeout(URLS.zhvi);
    zhvi = parseZillowWide(await res.text());
    if (zhvi.dateCols.length === 0) throw new Error("no date columns in ZHVI");
  } catch (err) {
    console.warn(`[warn] Zillow ZHVI failed: ${err.message}, keeping existing value`);
    zhvi = null;
  }

  // -- ZORI -----------------------------------------------------------------
  let zori = null;
  try {
    const res = await fetchWithTimeout(URLS.zori);
    zori = parseZillowWide(await res.text());
    if (zori.dateCols.length === 0) throw new Error("no date columns in ZORI");
  } catch (err) {
    console.warn(`[warn] Zillow ZORI failed: ${err.message}, keeping existing value`);
    zori = null;
  }

  // Index ZORI rows by RegionName for the inner join.
  const rentByName = new Map();
  if (zori) {
    for (let r = 1; r < zori.rows.length; r++) {
      const row = zori.rows[r];
      const name = (row[zori.idx.regionName] || "").trim();
      if (!name) continue;
      const lv = latestValue(row, zori.dateCols);
      if (lv) rentByName.set(name, lv.value);
    }
  }

  // Build per-metro home values + 5yr appreciation, and national figures.
  if (zhvi) {
    const built = [];
    let usHome = null;
    let usHomeDate = null;
    let usAppr1 = null;
    let usAppr5 = null;

    for (let r = 1; r < zhvi.rows.length; r++) {
      const row = zhvi.rows[r];
      const name = (row[zhvi.idx.regionName] || "").trim();
      if (!name) continue;

      const colIdx = latestColIndex(row, zhvi.dateCols);
      if (colIdx < 0) continue;
      const homeValue = Number(row[zhvi.dateCols[colIdx].col]);
      const latestInfo = { colIndex: colIdx };

      // 5yr CAGR for this metro (best effort).
      const back5 = valueMonthsBack(row, zhvi.dateCols, latestInfo, 60);
      let appr5 = null;
      if (back5) appr5 = cagr(back5.value, homeValue, back5.monthsAgo);

      const isUS = name === "United States";
      if (isUS) {
        usHome = Math.round(homeValue);
        usHomeDate = zhvi.dateCols[colIdx].date;
        const back1 = valueMonthsBack(row, zhvi.dateCols, latestInfo, 12);
        if (back1) usAppr1 = cagr(back1.value, homeValue, back1.monthsAgo);
        usAppr5 = appr5;
      }

      const rent = rentByName.get(name);
      // Inner join: metros must have BOTH a home value and a rent.
      // (US is added explicitly below so it always appears.)
      if (rent == null || !(rent > 0)) {
        if (!isUS) continue;
      }

      const sizeRank = Number(row[zhvi.idx.sizeRank]);
      const item = {
        id: slugify(name),
        metro: name,
        state: isUS ? "US" : stateFromRow(row, zhvi.idx),
        homeValue: Math.round(homeValue),
        rent: rent != null ? Math.round(rent) : undefined,
        _sizeRank: Number.isFinite(sizeRank) ? sizeRank : Number.MAX_SAFE_INTEGER,
      };
      if (appr5 != null) item.appreciation5yr = round4(appr5);
      built.push(item);
    }

    // National figures for market.json.
    if (usHome != null) {
      const rentUS = rentByName.get("United States");
      national = {
        homeValue: usHome,
        rent: rentUS != null ? Math.round(rentUS) : existingMarket.national.rent,
        asOf: zhviMonth(usHomeDate),
        source: "Zillow ZHVI/ZORI (US)",
      };
    }
    if (usAppr1 != null || usAppr5 != null) {
      appreciation = {
        rate1yr: usAppr1 != null ? round4(usAppr1) : existingMarket.appreciation.rate1yr,
        rate5yrCagr: usAppr5 != null ? round4(usAppr5) : existingMarket.appreciation.rate5yrCagr,
        asOf: usHomeDate ? zhviMonth(usHomeDate) : existingMarket.appreciation.asOf,
        source: "Zillow ZHVI (US), CAGR",
      };
    }

    // Assemble locations: US first, then largest metros (with rent) by SizeRank.
    const us = built.find((b) => b.metro === "United States");
    const metros = built
      .filter((b) => b.metro !== "United States" && b.rent != null)
      .sort((a, b) => a._sizeRank - b._sizeRank)
      .slice(0, MAX_METROS);

    const finalList = [];
    if (us) {
      finalList.push(cleanLocation(us));
    } else if (national) {
      finalList.push({
        id: "united-states",
        metro: "United States",
        state: "US",
        homeValue: national.homeValue,
        rent: national.rent,
        ...(appreciation.rate5yrCagr != null ? { appreciation5yr: appreciation.rate5yrCagr } : {}),
      });
    }
    for (const m of metros) finalList.push(cleanLocation(m));

    if (finalList.length > 1) {
      locations = finalList;
      summary.push(
        `locations: UPDATED ${finalList.length} entries (US + ${metros.length} metros)`,
      );
    } else {
      summary.push(`locations: fell back (${existingLocations.length} entries)`);
    }
  } else {
    summary.push(`locations: fell back (${existingLocations.length} entries)`);
  }

  if (national !== existingMarket.national) {
    summary.push(
      `national: UPDATED homeValue=${national.homeValue} rent=${national.rent} (${national.asOf})`,
    );
  } else {
    summary.push(`national: fell back (homeValue=${existingMarket.national.homeValue})`);
  }
  if (appreciation !== existingMarket.appreciation) {
    summary.push(
      `appreciation: UPDATED 1yr=${appreciation.rate1yr} 5yrCagr=${appreciation.rate5yrCagr} (${appreciation.asOf})`,
    );
  } else {
    summary.push(`appreciation: fell back (5yrCagr=${existingMarket.appreciation.rate5yrCagr})`);
  }

  return { national, appreciation, locations };
}

// "2026-04-30" -> "2026-04" (month granularity for asOf labels).
function zhviMonth(d) {
  return typeof d === "string" && d.length >= 7 ? d.slice(0, 7) : d;
}

// Strip internal fields and drop undefined rent before emitting.
function cleanLocation(item) {
  const out = {
    id: item.id,
    metro: item.metro,
    state: item.state,
    homeValue: item.homeValue,
  };
  if (item.rent != null) out.rent = item.rent;
  if (item.appreciation5yr != null) out.appreciation5yr = item.appreciation5yr;
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const market = await readJsonOr(MARKET_PATH, DEFAULT_MARKET);
  const existingLocations = await readJsonOr(LOCATIONS_PATH, DEFAULT_LOCATIONS);
  // Ensure shape exists even if the committed file was partial.
  market.mortgage ??= structuredClone(DEFAULT_MARKET.mortgage);
  market.inflation ??= structuredClone(DEFAULT_MARKET.inflation);
  market.appreciation ??= structuredClone(DEFAULT_MARKET.appreciation);
  market.national ??= structuredClone(DEFAULT_MARKET.national);

  const summary = [];

  // Run independent fetches concurrently; each is internally fault-tolerant.
  const [mortgage, inflation, zillow] = await Promise.all([
    fetchMortgage(market.mortgage, summary),
    fetchInflation(market.inflation, summary),
    fetchZillow(market, existingLocations, summary),
  ]);

  const newMarket = {
    asOf: new Date().toISOString().slice(0, 10),
    mortgage,
    inflation,
    appreciation: zillow.appreciation,
    national: zillow.national,
  };

  // Property tax is curated, not fetched; always write the current table.
  await writeFile(MARKET_PATH, JSON.stringify(newMarket, null, 2) + "\n");
  await writeFile(LOCATIONS_PATH, JSON.stringify(zillow.locations, null, 2) + "\n");
  await writeFile(PROPERTY_TAX_PATH, JSON.stringify(PROPERTY_TAX, null, 2) + "\n");

  console.log("\n=== fetch-data summary ===");
  for (const line of summary) console.log("  " + line);
  console.log(`  propertyTax: wrote ${Object.keys(PROPERTY_TAX).length - 2} states/DC (curated)`);
  console.log("==========================\n");
}

main().catch((err) => {
  // Even a top-level crash should not fail the build; write nothing and exit 0.
  console.warn(`[warn] fetch-data top-level error: ${err.message}; exiting 0 to protect build`);
  process.exit(0);
});
