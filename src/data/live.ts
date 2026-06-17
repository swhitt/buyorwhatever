import type { MarketData } from "./types";

// The repo's data files, served by jsDelivr's CDN straight off `main`. Fetching
// these at runtime lets the live site reflect data committed between full deploys
// (e.g. the weekly sync, or a manual "refresh data" run) without a rebuild. The
// bundled JSON remains the source of truth and the fallback, so this is always an
// upgrade, never a dependency: any failure leaves the build-time data in place.
const CDN = "https://cdn.jsdelivr.net/gh/swhitt/breakeven@main/src/data";
const TIMEOUT_MS = 6000;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Validate every numeric leaf the app actually reads off live data, not just a
// couple. A half-written commit or schema drift can yield valid JSON with one
// missing field, and clamp()/Math.max() on undefined silently produce NaN that
// then floods the whole sim, defeating the bundled-fallback guarantee.
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function isMarket(v: unknown): v is MarketData {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  const mortgage = m.mortgage as Record<string, unknown> | undefined;
  const inflation = m.inflation as Record<string, unknown> | undefined;
  const national = m.national as Record<string, unknown> | undefined;
  const appreciation = m.appreciation as Record<string, unknown> | undefined;
  return (
    str(m.asOf) &&
    !!mortgage &&
    num(mortgage.rate30) &&
    num(mortgage.rate15) &&
    str(mortgage.asOf) &&
    !!inflation &&
    num(inflation.rate) &&
    str(inflation.asOf) &&
    // The Sources and Derivation panels render appreciation and the as-of dates directly off
    // live data, so a refresh that drops them must fail validation and fall back to the bundled
    // copy rather than rendering undefined / NaN. (jumboSpread stays optional, hence not checked.)
    !!appreciation &&
    num(appreciation.rate1yr) &&
    num(appreciation.rate5yrCagr) &&
    str(appreciation.asOf) &&
    !!national &&
    num(national.homeValue) &&
    num(national.rent) &&
    str(national.asOf)
  );
}

/**
 * Best-effort fetch of the freshest committed market.json. Returns null on any
 * failure (offline, blocked, slow, malformed) so the caller keeps the bundled
 * copy. Only the high-churn headline numbers (rates, inflation, national price/
 * rent, appreciation) are loaded live; the slow-moving metro/tax/insurance tables
 * ship with the build.
 */
export async function fetchLiveMarket(): Promise<MarketData | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // jsDelivr serves this with cache-control: max-age=604800 (7 days), so without an override
    // a returning visitor's browser pins a week-old copy and never sees a data refresh until it
    // expires. no-store forces a fresh pull from jsDelivr's edge (which we purge on every
    // refresh) each load. The payload is ~400 bytes, so the cost is nil, and a network failure
    // still falls back to the build-time market.json bundled with the app.
    const res = await fetch(`${CDN}/market.json`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return isMarket(json) ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
