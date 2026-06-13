import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { calculate, housingPaymentLines, type CalcInputs, type CalcResult } from "./engine/calculator";
import { buildInputs, type AppInputs } from "./engine/defaults";
import { estimateMarginalRate, estimateStateIncomeTax } from "./engine/taxRates";
import { Controls } from "./components/Controls";
import { Breakdown } from "./components/Breakdown";
import { Derivation } from "./components/Derivation";
import { Disclosure } from "./ui";
import { yearsLabel, pct, usd } from "./lib/format";
import { decodeShare, encodeShare } from "./lib/share";
import {
  cleanOverrides,
  diffOverrides,
  overridesFromShare,
  pruneLocationOverrides,
  rememberOverrides,
} from "./lib/persist";
import { ThemeToggle } from "./theme";
import { detectMetro } from "./geo";
import { fetchLiveMarket } from "./data/live";
import type { LocationData, MarketData, StateRateTable } from "./data/types";

import marketRaw from "./data/market.json";
import locationsRaw from "./data/locations.json";
import propertyTaxRaw from "./data/propertyTax.json";
import insuranceRaw from "./data/insurance.json";

// Recharts (+d3) is ~half the bundle and only used below the fold, so load it
// lazily off the critical path.
const CrossoverChart = lazy(() =>
  import("./components/CrossoverChart").then((m) => ({ default: m.CrossoverChart })),
);
const AdvantageChart = lazy(() =>
  import("./components/AdvantageChart").then((m) => ({ default: m.AdvantageChart })),
);
const CostCompositionChart = lazy(() =>
  import("./components/CostCompositionChart").then((m) => ({ default: m.CostCompositionChart })),
);
const SensitivityChart = lazy(() =>
  import("./components/SensitivityChart").then((m) => ({ default: m.SensitivityChart })),
);

const locations = locationsRaw as LocationData[];
// The JSON carries _source/_asOf string metadata alongside the numeric rates,
// so cast through unknown; state-code lookups are unaffected.
const propertyTax = propertyTaxRaw as unknown as StateRateTable;
const insurance = insuranceRaw as unknown as StateRateTable;

const usHome = locations.find((l) => l.id === "united-states") ?? locations[0];
const METRO_KEY = "bow:metro"; // last selected metro (detected or chosen)
const HOME_KEY = "bow:home"; // the auto-detected locale, never overwritten by manual picks
const OVERRIDES_KEY = "bow:overrides";

// Returning visitors keep their last metro (no flash, no re-detect).
function storedLocation(): LocationData {
  try {
    const id = localStorage.getItem(METRO_KEY);
    if (id) return locations.find((l) => l.id === id) ?? usHome;
  } catch {
    /* storage unavailable */
  }
  return usHome;
}

// Read the remembered edits from storage; cleanOverrides whitelists + validates them so
// corrupted storage can't reach the engine.
function loadOverrides(): Partial<AppInputs> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (raw) return cleanOverrides(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    /* storage unavailable or malformed */
  }
  return {};
}

function saveOverrides(o: Partial<AppInputs>) {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
}

// A ?s= share token decoded into a starting location + overrides, or null. It
// carries only the fields the sharer changed from defaults, so we validate each
// against a reference inputs object by type and re-derive the rest from live data.
function readShareLink(): { loc: LocationData; overrides: Partial<AppInputs> } | null {
  try {
    const token = new URLSearchParams(window.location.search).get("s");
    if (!token) return null;
    const payload = decodeShare(token);
    if (!payload) return null;
    const loc = (payload.m ? locations.find((l) => l.id === payload.m) : null) ?? usHome;
    const ref = buildInputs(usHome, marketRaw as MarketData, propertyTax, insurance);
    return { loc, overrides: overridesFromShare(payload.o ?? {}, ref) };
  } catch {
    return null;
  }
}

// Decoded once at module load (before first render) so the initial state can use it.
const SHARE = typeof window !== "undefined" ? readShareLink() : null;

export function App({ initialMetroSlug }: { initialMetroSlug?: string } = {}) {
  // A /metro-id deep-link (e.g. /houston-tx) opens the calculator pre-set to that metro,
  // fresh from its defaults (no stored edits). A ?s= share link still wins over it.
  const urlMetro = initialMetroSlug ? locations.find((l) => l.id === initialMetroSlug) : undefined;
  const startLoc = SHARE ? SHARE.loc : (urlMetro ?? storedLocation());
  const overrides = useRef<Partial<AppInputs>>(SHARE ? SHARE.overrides : urlMetro ? {} : loadOverrides());
  // While viewing a ?s= share link, don't write to the visitor's own localStorage;
  // the link is authoritative for the page and Reset exits the shared view.
  const shareActive = useRef(SHARE != null);
  const [copied, setCopied] = useState(false);
  const [justReset, setJustReset] = useState(false);
  // True once the user edits any input; gates the one-time re-seed from live data.
  const touched = useRef(false);
  const [market, setMarket] = useState<MarketData>(() => marketRaw as MarketData);
  const [selected, setSelected] = useState<LocationData>(() => startLoc);
  const [inputs, setInputs] = useState<AppInputs>(() => ({
    ...buildInputs(startLoc, marketRaw as MarketData, propertyTax, insurance),
    ...overrides.current, // restore the user's remembered edits, or the shared ones
  }));

  // When the tax-rate estimator is on, derive the deduction inputs from income +
  // filing + state at calc time rather than storing them back, so the manual
  // controls keep their own values and there's no patch loop. The mortgage-interest
  // and property-tax deductions are FEDERAL itemized deductions, so they save at
  // the federal marginal rate; state and local income tax don't raise that rate but
  // do join property tax in the SALT base (capped), so they feed otherSALT.
  // ASSUMPTION: state-return itemization (some states let you deduct mortgage
  // interest / property tax too) is intentionally NOT modeled. It errs slightly
  // toward renting, consistent with the conservative defaults. Don't "fix" this by
  // passing est.combined into marginalTaxRate: that double-counts against the SALT base.
  const inputsForCalc = useMemo<CalcInputs>(() => {
    if (!inputs.taxAuto || inputs.annualIncome <= 0) return inputs;
    const est = estimateMarginalRate(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
    const stateSalt = estimateStateIncomeTax(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
    return { ...inputs, marginalTaxRate: est.federal, otherSALT: stateSalt };
  }, [inputs]);

  const result = useMemo(() => calculate(inputsForCalc), [inputsForCalc]);

  // A /metro deep-link gets a metro-specific tab title (the static HTML still carries
  // the generic one for crawlers until the per-metro prerender lands).
  useEffect(() => {
    if (urlMetro) document.title = `Rent vs. buy in ${urlMetro.metro} | breakEven`;
  }, [urlMetro]);

  // Mirror the current selection in a ref so async geo callbacks can tell whether
  // the user has moved on since they were kicked off (avoids yanking the location).
  const selectedRef = useRef(selected.id);
  useEffect(() => {
    selectedRef.current = selected.id;
  }, [selected]);

  // Manual edits from the controls. Persist the ones we remember.
  const patch = (p: Partial<AppInputs>) => {
    touched.current = true;
    setInputs((prev) => ({ ...prev, ...p }));
    const changed = rememberOverrides(overrides.current, p);
    if (changed && !shareActive.current) saveOverrides(overrides.current);
  };

  function selectLocation(loc: LocationData, remember = true) {
    setSelected(loc);
    // Set location-derived fields directly (not via patch) so they aren't
    // recorded as manual overrides.
    setInputs((prev) => {
      const insRate = insurance[loc.state] ?? (prev.homeInsurance.kind === "pctOfValue" ? prev.homeInsurance.rate : 0.005);
      const taxRate = propertyTax[loc.state] ?? (prev.propertyTax.kind === "pctOfValue" ? prev.propertyTax.rate : 0.011);
      return {
        ...prev,
        homePrice: loc.homeValue,
        monthlyRent: loc.rent,
        // Re-point each rate to the new location ONLY where it's still percent-of-value.
        // A flat-dollar figure is one the user typed, so it's left alone.
        propertyTax: prev.propertyTax.kind === "pctOfValue" ? { kind: "pctOfValue", rate: taxRate } : prev.propertyTax,
        homeInsurance:
          prev.homeInsurance.kind === "pctOfValue" ? { kind: "pctOfValue", rate: insRate } : prev.homeInsurance,
        taxState: loc.state,
      };
    });
    // A new place invalidates place-specific overrides (kept personal ones).
    const changed = pruneLocationOverrides(overrides.current);
    if (changed && !shareActive.current) saveOverrides(overrides.current);
    if (remember && !shareActive.current) {
      try {
        localStorage.setItem(METRO_KEY, loc.id);
      } catch {
        /* storage unavailable */
      }
    }
  }

  // Jump to a location with its defaults (no manual overrides applied).
  function goTo(loc: LocationData) {
    setSelected(loc);
    setInputs(buildInputs(loc, market, propertyTax, insurance));
    try {
      localStorage.setItem(METRO_KEY, loc.id);
    } catch {
      /* storage unavailable */
    }
  }

  // Reset = back to your locale's defaults: drop manual edits and return to the
  // auto-detected home metro (re-detecting if we don't have it remembered yet).
  function reset() {
    // Flash a confirmation so the click clearly registers (the inputs may snap back
    // to values that already matched, leaving no other visible change).
    setJustReset(true);
    window.setTimeout(() => setJustReset(false), 1500);
    // Leaving a shared view: resume normal persistence and drop the ?s= token so a
    // reload doesn't snap back to it.
    if (shareActive.current) {
      shareActive.current = false;
      try {
        const u = new URL(window.location.href);
        if (u.searchParams.has("s")) {
          u.searchParams.delete("s");
          window.history.replaceState(null, "", u.pathname + u.search + u.hash);
        }
      } catch {
        /* ignore */
      }
    }
    overrides.current = {};
    saveOverrides({});
    let homeId: string | null = null;
    try {
      homeId = localStorage.getItem(HOME_KEY);
    } catch {
      /* storage unavailable */
    }
    const home = homeId ? locations.find((l) => l.id === homeId) : undefined;
    if (home) {
      goTo(home);
      return;
    }
    // No remembered home yet: reset the current locale now, detect home in the
    // background and hop to it (silent fallback keeps the current locale).
    const resetFrom = selected.id;
    goTo(selected);
    detectMetro(locations).then((loc) => {
      if (!loc) return;
      try {
        localStorage.setItem(HOME_KEY, loc.id);
      } catch {
        /* storage unavailable */
      }
      // Only hop if the user hasn't picked a different metro since reset.
      if (selectedRef.current === resetFrom) goTo(loc);
    });
  }

  // Copy a link that reproduces this exact view: the metro plus only the fields the
  // user changed from that metro's defaults (so the link stays short and re-derives
  // everything else from live data on open).
  function share() {
    try {
      const defaults = buildInputs(selected, market, propertyTax, insurance);
      const o = diffOverrides(inputs, defaults);
      const url = `${window.location.origin}${window.location.pathname}?s=${encodeShare({ m: selected.id, o })}`;
      void navigator.clipboard?.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  }

  // Pull the freshest committed market data from the CDN once on load. If the user
  // hasn't touched anything yet, re-seed inputs from it so the headline calc uses
  // the fresher rates too; otherwise just update the live badges and "as of" date.
  useEffect(() => {
    let cancelled = false;
    fetchLiveMarket().then((live) => {
      if (cancelled || !live) return;
      setMarket(live);
      if (!touched.current && Object.keys(overrides.current).length === 0) {
        const loc = locations.find((l) => l.id === selectedRef.current) ?? selected;
        setInputs(buildInputs(loc, live, propertyTax, insurance));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // First visit with no saved metro: auto-detect from IP (silent fallback to US).
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    if (SHARE || urlMetro) return; // a share link or /metro deep-link dictates the location
    let stored = false;
    try {
      stored = !!localStorage.getItem(METRO_KEY);
    } catch {
      /* storage unavailable */
    }
    if (stored) return;
    let cancelled = false;
    detectMetro(locations).then((loc) => {
      if (cancelled || !loc) return;
      // The user may have picked a metro while detection was in flight;
      // selectLocation writes METRO_KEY synchronously, so bail if it's set now.
      try {
        if (localStorage.getItem(METRO_KEY)) return;
        localStorage.setItem(HOME_KEY, loc.id); // remember the locale for Reset
      } catch {
        /* storage unavailable */
      }
      selectLocation(loc);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen overflow-x-clip">
      <Header market={market} />

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <Hero metro={selected.metro} result={result} inputs={inputs} />

        {/* On mobile the controls stack above the results, so surface a one-line
            verdict up top for immediate feedback (hidden on lg, where the full
            Verdict sits beside the controls). */}
        <div className="mt-6 lg:hidden">
          <CondensedVerdict result={result} inputs={inputs} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:mt-8 lg:grid-cols-[minmax(0,380px)_1fr]">
          {/* Sticky offset clears the ~57px sticky header (was top-6, which let the
              header overlap the panel's first line). */}
          <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6 lg:sticky lg:top-[72px] lg:self-start">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Your situation</h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={share}
                  title="Copy a link to this exact scenario"
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-ink"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
                  </svg>
                  {copied ? "Copied!" : "Share"}
                </button>
                <button
                  type="button"
                  onClick={reset}
                  aria-live="polite"
                  title="Reset to your location's defaults"
                  className={
                    "inline-flex items-center gap-1 text-xs font-medium transition-colors " +
                    (justReset ? "text-rent-text" : "text-muted hover:text-ink")
                  }
                >
                  {justReset ? (
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12l4 4 10-10" />
                    </svg>
                  ) : (
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  )}
                  {justReset ? "Reset!" : "Reset"}
                </button>
              </div>
            </div>
            <Controls
              inputs={inputs}
              patch={patch}
              locations={locations}
              selected={selected}
              onSelectLocation={selectLocation}
              market={market}
            />
          </section>

          <section className="min-w-0 space-y-6">
            <Verdict result={result} inputs={inputs} />

            <MonthlyPayment result={result} />

            <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-bold">Cost of buying vs. renting over time</h3>
                <Legend />
              </div>
              <p className="mb-4 text-sm text-muted">
                Total net cost, in today's dollars, if you sold and moved out after each year. Where the lines cross is
                the point buying pulls ahead; the faint dot marks the year you said you'll stay.
              </p>
              <Suspense fallback={<div className="h-72 w-full sm:h-80" />}>
                <CrossoverChart
                  data={result.horizon}
                  breakevenYear={result.breakevenYear}
                  yearsToStay={inputs.yearsToStay}
                />
              </Suspense>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-bold">How far ahead each option is</h3>
                <AdvantageLegend />
              </div>
              <p className="mb-4 text-sm text-muted">
                The gap between the two lines above, plotted off a zero line so it's legible. Below zero, renting is
                ahead by that much; above zero, buying is. Where it crosses is the year buying takes the lead.
              </p>
              <Suspense fallback={<div className="h-72 w-full sm:h-80" />}>
                <AdvantageChart
                  data={result.horizon}
                  breakevenYear={result.breakevenYear}
                  yearsToStay={inputs.yearsToStay}
                />
              </Suspense>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
              <h3 className="text-base font-bold">Where each year's payment goes</h3>
              <p className="mb-4 mt-1 text-sm text-muted">
                Every year you own, split into where the money lands. Interest dominates early and fades as principal
                (which builds equity, not a sunk cost) takes over{inputs.yearsToStay === 1 ? "" : " across your stay"}.
              </p>
              <Suspense fallback={<div className="h-72 w-full sm:h-80" />}>
                <CostCompositionChart years={result.years} />
              </Suspense>
            </div>

            <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
              <h3 className="text-base font-bold">What actually moves the answer</h3>
              <p className="mb-4 mt-1 text-sm text-muted">
                Each bar swings one uncertain assumption across a realistic range and shows where the breakeven rent
                lands. Left of your rent, buying wins; right of it, renting wins. The widest bars are what your verdict
                hangs on, and any bar crossing your rent is an assumption that could flip it on its own.
              </p>
              <Suspense fallback={<div className="h-72 w-full sm:h-80" />}>
                <SensitivityChart inputs={inputsForCalc} monthlyRent={inputs.monthlyRent} />
              </Suspense>
            </div>
          </section>
        </div>

        {/* Full-width so the wide tables have room to breathe. */}
        <div className="mt-6 space-y-3">
          <Disclosure summary="How your rates are derived">
            <Derivation inputs={inputs} result={result} market={market} selected={selected} />
          </Disclosure>
          <Disclosure summary="Year-by-year breakdown">
            <Breakdown years={result.years} />
          </Disclosure>
        </div>

        <Sources market={market} />
      </main>
    </div>
  );
}

function Header({ market }: { market: MarketData }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-paper/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-extrabold tracking-tight">
            <span className="text-rent">break</span>
            <span className="text-buy">Even</span>
          </span>
          <span className="hidden text-sm text-muted sm:inline">rent vs. buy, with the math shown</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="hidden sm:inline">
            data fresh as of <span className="font-semibold text-ink">{market.asOf}</span>
          </span>
          <a
            href="https://github.com/swhitt/breakeven"
            className="font-semibold text-ink underline-offset-2 hover:underline"
          >
            GitHub
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function Hero({ metro, result, inputs }: { metro: string; result: ReturnType<typeof calculate>; inputs: CalcInputs }) {
  const renting = result.verdict === "rent";
  return (
    <div className="pt-10 sm:pt-14">
      <p className="text-sm font-semibold uppercase tracking-wide text-muted">
        Should you rent or buy in {metro}?
      </p>
      <h1 className="mt-2 max-w-3xl text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">
        {renting ? (
          <>
            At <span className="text-rent">{usd(inputs.monthlyRent)}/mo</span>, renting comes out ahead.
          </>
        ) : (
          <>
            At <span className="text-buy">{usd(inputs.monthlyRent)}/mo</span> rent, buying comes out ahead.
          </>
        )}
      </h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">
        Buying only beats renting if a comparable home rents for more than{" "}
        <span className="font-semibold text-ink">{usd(result.breakevenRent)}/mo</span>.{" "}
        {result.breakevenYear == null ? (
          <>
            At <span className="font-semibold text-ink">{usd(inputs.monthlyRent)}/mo</span>, owning never catches up,
            even over the longest horizon shown below.
          </>
        ) : (
          <>
            Stay longer than{" "}
            <span className="font-semibold text-ink">{yearsLabel(result.breakevenYear)}</span> and the math flips
            toward owning.
          </>
        )}
      </p>
    </div>
  );
}

// Within 5% of the breakeven the verdict is a near-tie; below that the gap reads
// like a real rent-vs-buy advantage worth naming.
const isCloseCall = (result: CalcResult, inputs: CalcInputs) =>
  Math.abs(result.monthlyDifference) < inputs.monthlyRent * 0.05;
const verdictLabel = (result: CalcResult, inputs: CalcInputs) =>
  isCloseCall(result, inputs) ? "Toss-up" : result.verdict === "rent" ? "Rent it" : "Buy it";

// A one-line verdict for mobile, shown above the controls so there's immediate
// feedback without scrolling past every input first.
function CondensedVerdict({ result, inputs }: { result: ReturnType<typeof calculate>; inputs: CalcInputs }) {
  const renting = result.verdict === "rent";
  return (
    <div
      className={
        "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-sm " +
        (renting ? "border-rent/30 bg-rent-soft/40" : "border-buy/30 bg-buy-soft/40")
      }
    >
      <div>
        <div className={"text-[11px] font-bold uppercase tracking-wide " + (renting ? "text-rent-text" : "text-buy-text")}>
          Verdict
        </div>
        <div className="text-lg font-extrabold">{verdictLabel(result, inputs)}</div>
      </div>
      <div className="text-right">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Breakeven rent</div>
        <div className="tnum text-lg font-bold">{usd(result.breakevenRent)}/mo</div>
      </div>
    </div>
  );
}

function Verdict({ result, inputs }: { result: ReturnType<typeof calculate>; inputs: CalcInputs }) {
  const renting = result.verdict === "rent";
  const diff = Math.abs(result.monthlyDifference);
  const closeCall = isCloseCall(result, inputs);
  return (
    <div
      className={
        "overflow-hidden rounded-2xl border shadow-sm " +
        (renting ? "border-rent/30 bg-rent-soft/40" : "border-buy/30 bg-buy-soft/40")
      }
    >
      <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="p-5 sm:p-6">
          <div className={"text-xs font-bold uppercase tracking-wide " + (renting ? "text-rent-text" : "text-buy-text")}>
            Verdict
          </div>
          <div className="mt-1 text-2xl font-extrabold">{verdictLabel(result, inputs)}</div>
          <p className="mt-1 text-sm text-muted">
            {closeCall
              ? "Basically a wash, sensitive to your assumptions."
              : renting
                ? `Your rent is about ${usd(diff)}/mo below the breakeven.`
                : `Your rent is about ${usd(diff)}/mo above the breakeven.`}
          </p>
        </div>
        <Stat label="Breakeven rent" value={`${usd(result.breakevenRent)}/mo`} sub="buy wins above this" />
        <Stat
          label="Breakeven horizon"
          value={result.breakevenYear == null ? "Never" : yearsLabel(result.breakevenYear)}
          sub={result.breakevenYear == null ? "owning never catches up" : "stay longer, buying wins"}
        />
      </div>
      <div className="grid grid-cols-2 border-t border-line bg-surface/60 sm:grid-cols-4">
        <MiniStat label="P&I / mo" value={usd(result.monthlyPayment)} />
        <MiniStat label="Loan amount" value={usd(result.loanAmount)} />
        <MiniStat label={`Buy total · ${inputs.yearsToStay}yr`} value={usd(result.buyNetCost)} />
        <MiniStat label={`Rent total · ${inputs.yearsToStay}yr`} value={usd(result.rentNetCost)} />
      </div>
    </div>
  );
}

// Zillow-style payment breakdown, but netting out the federal tax benefit to a
// "net effective" monthly figure (Year 1) so the affordability picture is honest.
// The headline says what it is; the itemized lines live behind an expander.
function MonthlyPayment({ result }: { result: ReturnType<typeof calculate> }) {
  const [open, setOpen] = useState(false);
  const y1 = result.years[0];
  if (!y1) return null;
  const pni = result.monthlyPayment;
  const taxBenefit = y1.taxBenefit / 12;
  // Escrow-style carrying costs straight from the registry, so a new one flows into
  // the headline automatically (maintenance is excluded by not being flagged).
  const lines = housingPaymentLines(y1).filter((l) => l.monthly > 0);
  const gross = pni + lines.reduce((s, l) => s + l.monthly, 0);
  const net = gross - taxBenefit;
  const rows: { label: string; value: number; credit?: boolean }[] = [
    { label: "Principal & interest", value: pni },
    ...lines.map((l) => ({ label: l.label, value: l.monthly })),
    ...(taxBenefit > 0 ? [{ label: "Tax benefit", value: taxBenefit, credit: true }] : []),
  ];

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-bold">Net effective monthly payment</h3>
        <div className="text-right">
          <span className="tnum text-2xl font-extrabold">{usd(net)}</span>
          <span className="text-base font-semibold text-muted">/mo</span>
        </div>
      </div>
      <p className="mt-1 text-sm text-muted">
        Your all-in monthly housing payment (principal &amp; interest, property tax, insurance, plus any HOA and PMI) in
        year 1,
        {taxBenefit > 0 ? (
          <>
            {" "}
            minus the estimated federal tax benefit (what itemizing the mortgage interest and SALT saves over the
            standard deduction), so <span className="text-ink">{usd(gross)}/mo</span> before it.
          </>
        ) : (
          " before any tax benefit: at these numbers itemizing doesn't beat the standard deduction, so there's nothing to net out."
        )}
      </p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-muted transition-colors hover:text-ink"
      >
        {open ? "Hide" : "Show"} the breakdown
        <svg
          className={"h-3.5 w-3.5 transition-transform " + (open ? "rotate-180" : "")}
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <>
          <dl className="mt-3 space-y-1.5 border-t border-line/60 pt-3">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3">
                <dt className="text-sm text-muted">{r.label}</dt>
                <dd className={"tnum text-sm font-semibold " + (r.credit ? "text-rent-text" : "text-ink")}>
                  {r.credit ? `-${usd(r.value)}` : usd(r.value)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted">
            Year 1, from the property tax, insurance, and HOA figures you entered. The tax benefit shrinks as interest
            falls, so this nudges up over time. Excludes maintenance and the down payment's opportunity cost (both in
            the full cost model).
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="p-5 sm:p-6">
      <div className="text-xs font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className="tnum mt-1 text-2xl font-extrabold">{value}</div>
      <p className="mt-1 text-sm text-muted">{sub}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="tnum text-sm font-bold">{value}</div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded bg-buy" /> Buying
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-4 border-t-2 border-dashed border-rent" /> Renting
      </span>
    </div>
  );
}

function AdvantageLegend() {
  return (
    <div className="flex items-center gap-4 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-sm bg-buy" /> Buying ahead
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-sm bg-rent" /> Renting ahead
      </span>
    </div>
  );
}

function Sources({ market }: { market: MarketData }) {
  const items: { label: string; value: string; href: string }[] = [
    {
      label: "Mortgage rates",
      value: `Freddie Mac PMMS · ${pct(market.mortgage.rate30, 2)} (${market.mortgage.asOf})`,
      href: "https://www.freddiemac.com/pmms",
    },
    {
      label: "Home prices & rents",
      value: `Zillow ZHVI / ZORI asking rents (${market.national.asOf})`,
      href: "https://www.zillow.com/research/data/",
    },
    {
      label: "Inflation",
      value: `BLS CPI-U · ${pct(market.inflation.rate, 1)} YoY (${market.inflation.asOf})`,
      href: "https://www.bls.gov/cpi/",
    },
    {
      label: "Property tax",
      value: "WalletHub / Census ACS 2024, median effective rate by state",
      href: "https://wallethub.com/edu/states-with-the-highest-and-lowest-property-taxes/11585",
    },
    {
      label: "Home insurance",
      value: "NAIC HO-3 premiums / Zillow ZHVI, effective rate by state",
      href: "https://www.iii.org/fact-statistic/facts-statistics-homeowners-and-renters-insurance",
    },
    {
      label: "Capital gains",
      value: "IRS Topic 701 · $250k single / $500k joint exclusion",
      href: "https://www.irs.gov/taxtopics/tc701",
    },
    {
      label: "Method",
      value: "User-cost model, Himmelberg-Mayer-Sinai (2005)",
      href: "https://www.nber.org/papers/w11643",
    },
  ];

  return (
    <footer className="mt-16 border-t border-line pt-8">
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Where the numbers come from</h2>
      <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((s) => (
          <a
            key={s.label}
            href={s.href}
            target="_blank"
            rel="noreferrer"
            className="group rounded-lg border border-transparent p-2 hover:border-line hover:bg-surface"
          >
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">{s.label}</div>
            <div className="text-sm font-medium text-ink group-hover:underline">{s.value}</div>
          </a>
        ))}
      </div>

      <div className="mt-8 space-y-2 text-sm text-muted">
        <p>
          The model converts every cost of owning (mortgage interest and principal, taxes, maintenance, insurance,
          PMI, closing and selling costs, lost investment returns) into a single breakeven monthly rent, discounting
          all future cash flow at your investment-return rate. It uses a four-bucket cost decomposition
          (initial costs, recurring costs, opportunity costs, and net sale proceeds), grounded in the academic
          user-cost-of-homeownership literature.
        </p>
        <p>
          Caveats: the SALT cap, standard deduction, and capital-gains brackets are simplified and change with
          tax law, so treat the deduction math as an estimate. Appreciation defaults to a conservative long-run figure
          rather than recent local run-ups. The rent figure is Zillow ZORI, which tracks asking rents on newly-listed
          units and runs ahead of what a tenant renewing in place pays, so in a hot market the default may be high.
          Adjust any input to your own numbers. This is a decision aid, not financial advice.
        </p>
        <p className="pt-2">
          Free and open source. Data refreshes automatically.{" "}
          <a href="https://github.com/swhitt/breakeven" className="font-semibold text-ink hover:underline">
            View the code and the model on GitHub.
          </a>
        </p>
      </div>
    </footer>
  );
}
