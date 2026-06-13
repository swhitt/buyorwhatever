import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { calculate, type CalcInputs } from "./engine/calculator";
import { buildInputs } from "./engine/defaults";
import { estimateMarginalRate, estimateStateIncomeTax } from "./engine/taxRates";
import { Controls } from "./components/Controls";
import { Breakdown } from "./components/Breakdown";
import { Derivation } from "./components/Derivation";
import { Disclosure } from "./ui";
import { monthsAndYears, pct, usd } from "./lib/format";
import { decodeShare, encodeShare } from "./lib/share";
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

const locations = locationsRaw as LocationData[];
// The JSON carries _source/_asOf string metadata alongside the numeric rates,
// so cast through unknown; state-code lookups are unaffected.
const propertyTax = propertyTaxRaw as unknown as StateRateTable;
const insurance = insuranceRaw as unknown as StateRateTable;

const usHome = locations.find((l) => l.id === "united-states") ?? locations[0];
const METRO_KEY = "bow:metro"; // last selected metro (detected or chosen)
const HOME_KEY = "bow:home"; // the auto-detected locale, never overwritten by manual picks
const OVERRIDES_KEY = "bow:overrides";

// Manual edits we remember across reloads, each tagged with the kind we validate
// on load so corrupted storage can't reach the engine (a bad number renders $NaN,
// a bad enum breaks the toggle).
const PERSIST_SPEC = {
  homePrice: "number",
  monthlyRent: "number",
  downPaymentPct: "number",
  propertyTaxMode: "mode",
  propertyTaxRate: "number",
  propertyTaxAnnual: "number",
  maintenanceMode: "mode",
  maintenanceRate: "number",
  maintenanceAnnual: "number",
  homeInsuranceMode: "mode",
  homeInsuranceRate: "number",
  homeInsuranceAnnual: "number",
  marginalTaxRate: "number",
  filingJointly: "boolean",
  standardDeduction: "number",
  taxAuto: "boolean",
  annualIncome: "number",
  taxState: "string",
  localTaxRate: "number",
} as const satisfies Partial<Record<keyof CalcInputs, "number" | "mode" | "boolean" | "string">>;
const PERSIST_KEYS = Object.keys(PERSIST_SPEC) as (keyof typeof PERSIST_SPEC)[];
// Of those, the ones tied to a specific place: cleared when you pick a new metro
// (the override was for the old location), so they revert to that metro's default.
// The flat-dollar `*Annual` figures are deliberately NOT here: a number the user
// typed in $ mode is personal and survives a location switch (see selectLocation).
const LOCATION_FIELDS: (keyof CalcInputs)[] = [
  "homePrice",
  "monthlyRent",
  "propertyTaxRate",
  "homeInsuranceRate",
  "taxState",
];

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

// Whitelist to known fields and validate each by kind, so corrupted storage
// (e.g. {homePrice: null}, {maintenanceMode: 7}) can't reach the engine and
// render $NaN / a bogus $0 home or break a control.
function loadOverrides(): Partial<CalcInputs> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clean: Partial<CalcInputs> = {};
    for (const k of PERSIST_KEYS) {
      const v = parsed[k];
      switch (PERSIST_SPEC[k]) {
        case "number": {
          const n = typeof v === "string" ? Number(v) : v;
          if (typeof n === "number" && Number.isFinite(n)) clean[k] = n as never;
          break;
        }
        case "mode":
          if (v === "pct" || v === "amount") clean[k] = v as never;
          break;
        case "boolean":
          if (typeof v === "boolean") clean[k] = v as never;
          break;
        case "string":
          if (typeof v === "string") clean[k] = v as never;
          break;
      }
    }
    return clean;
  } catch {
    /* storage unavailable or malformed */
  }
  return {};
}

function saveOverrides(o: Partial<CalcInputs>) {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
}

// A ?s= share token decoded into a starting location + overrides, or null. It
// carries only the fields the sharer changed from defaults, so we validate each
// against a reference inputs object by type and re-derive the rest from live data.
function readShareLink(): { loc: LocationData; overrides: Partial<CalcInputs> } | null {
  try {
    const token = new URLSearchParams(window.location.search).get("s");
    if (!token) return null;
    const payload = decodeShare(token);
    if (!payload) return null;
    const loc = (payload.m ? locations.find((l) => l.id === payload.m) : null) ?? usHome;
    const ref = buildInputs(usHome, marketRaw as MarketData, propertyTax, insurance);
    const o = payload.o ?? {};
    const overrides: Partial<CalcInputs> = {};
    for (const k of Object.keys(ref) as (keyof CalcInputs)[]) {
      if (!(k in o)) continue;
      const v = o[k];
      const r = ref[k];
      if (typeof r === "number" && typeof v === "number" && Number.isFinite(v)) overrides[k] = v as never;
      else if (typeof r === "boolean" && typeof v === "boolean") overrides[k] = v as never;
      else if (typeof r === "string" && typeof v === "string") overrides[k] = v as never;
    }
    return { loc, overrides };
  } catch {
    return null;
  }
}

// Decoded once at module load (before first render) so the initial state can use it.
const SHARE = typeof window !== "undefined" ? readShareLink() : null;

export function App() {
  const overrides = useRef<Partial<CalcInputs>>(SHARE ? SHARE.overrides : loadOverrides());
  // While viewing a ?s= share link, don't write to the visitor's own localStorage;
  // the link is authoritative for the page and Reset exits the shared view.
  const shareActive = useRef(SHARE != null);
  const [copied, setCopied] = useState(false);
  // True once the user edits any input; gates the one-time re-seed from live data.
  const touched = useRef(false);
  const [market, setMarket] = useState<MarketData>(() => marketRaw as MarketData);
  const [selected, setSelected] = useState<LocationData>(() => (SHARE ? SHARE.loc : storedLocation()));
  const [inputs, setInputs] = useState<CalcInputs>(() => ({
    ...buildInputs(SHARE ? SHARE.loc : storedLocation(), marketRaw as MarketData, propertyTax, insurance),
    ...overrides.current, // restore the user's remembered edits, or the shared ones
  }));

  // When the tax-rate estimator is on, derive the deduction inputs from income +
  // filing + state at calc time rather than storing them back, so the manual
  // controls keep their own values and there's no patch loop. The mortgage-interest
  // and property-tax deductions are FEDERAL itemized deductions, so they save at
  // the federal marginal rate; state and local income tax don't raise that rate but
  // do join property tax in the SALT base (capped), so they feed otherSALT.
  const inputsForCalc = useMemo<CalcInputs>(() => {
    if (!inputs.taxAuto || inputs.annualIncome <= 0) return inputs;
    const est = estimateMarginalRate(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
    const stateSalt = estimateStateIncomeTax(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
    return { ...inputs, marginalTaxRate: est.federal, otherSALT: stateSalt };
  }, [inputs]);

  const result = useMemo(() => calculate(inputsForCalc), [inputsForCalc]);

  // Mirror the current selection in a ref so async geo callbacks can tell whether
  // the user has moved on since they were kicked off (avoids yanking the location).
  const selectedRef = useRef(selected.id);
  useEffect(() => {
    selectedRef.current = selected.id;
  }, [selected]);

  // Manual edits from the controls. Persist the ones we remember.
  const patch = (p: Partial<CalcInputs>) => {
    touched.current = true;
    setInputs((prev) => ({ ...prev, ...p }));
    let changed = false;
    for (const k of PERSIST_KEYS) {
      if (k in p) {
        overrides.current[k] = p[k] as never;
        changed = true;
      }
    }
    if (changed && !shareActive.current) saveOverrides(overrides.current);
  };

  function selectLocation(loc: LocationData, remember = true) {
    setSelected(loc);
    // Set location-derived fields directly (not via patch) so they aren't
    // recorded as manual overrides.
    setInputs((prev) => {
      const insRate = insurance[loc.state] ?? prev.homeInsuranceRate;
      const taxRate = propertyTax[loc.state] ?? prev.propertyTaxRate;
      return {
        ...prev,
        homePrice: loc.homeValue,
        monthlyRent: loc.rent,
        propertyTaxRate: taxRate,
        homeInsuranceRate: insRate,
        // Re-seed each flat-dollar figure off the new home value ONLY where that field
        // is in percent mode (the dollars are just a seed there). In amount mode the
        // number is one the user typed, so it's left alone. Point the estimator here too.
        propertyTaxAnnual: prev.propertyTaxMode === "amount" ? prev.propertyTaxAnnual : Math.round(loc.homeValue * taxRate),
        homeInsuranceAnnual:
          prev.homeInsuranceMode === "amount" ? prev.homeInsuranceAnnual : Math.round(loc.homeValue * insRate),
        maintenanceAnnual:
          prev.maintenanceMode === "amount" ? prev.maintenanceAnnual : Math.round(loc.homeValue * prev.maintenanceRate),
        taxState: loc.state,
      };
    });
    // A new place invalidates place-specific overrides (kept personal ones).
    let changed = false;
    for (const k of LOCATION_FIELDS) {
      if (k in overrides.current) {
        delete overrides.current[k];
        changed = true;
      }
    }
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
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(inputs) as (keyof CalcInputs)[]) {
        if (inputs[k] !== defaults[k]) o[k] = inputs[k];
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First visit with no saved metro: auto-detect from IP (silent fallback to US).
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    if (SHARE) return; // a shared link dictates the location; don't re-detect
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen">
      <Header market={market} />

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <Hero metro={selected.metro} result={result} inputs={inputs} />

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
          <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6 lg:sticky lg:top-6 lg:self-start">
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
                  title="Reset to your location's defaults"
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
                    <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  Reset
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

            <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-bold">Cost of buying vs. renting over time</h3>
                <Legend />
              </div>
              <p className="mb-4 text-sm text-muted">
                Net cost in today's dollars if you sell and move out after each year. Where the lines cross is the
                point buying pulls ahead.
              </p>
              <Suspense fallback={<div className="h-72 w-full sm:h-80" />}>
                <CrossoverChart
                  data={result.horizon}
                  breakevenYear={result.breakevenYear}
                  yearsToStay={inputs.yearsToStay}
                />
              </Suspense>
            </div>
          </section>
        </div>

        {/* Full-width so the wide tables have room to breathe. */}
        <div className="mt-6 space-y-3">
          <Disclosure summary="Show how your rates are derived">
            <Derivation inputs={inputs} result={result} market={market} selected={selected} />
          </Disclosure>
          <Disclosure summary="Show the year-by-year math">
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
          <span className="text-lg font-extrabold tracking-tight">Breakeven</span>
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
            <span className="font-semibold text-ink">{monthsAndYears(result.breakevenYear)}</span> and the math flips
            toward owning.
          </>
        )}
      </p>
    </div>
  );
}

function Verdict({ result, inputs }: { result: ReturnType<typeof calculate>; inputs: CalcInputs }) {
  const renting = result.verdict === "rent";
  const diff = Math.abs(result.monthlyDifference);
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
          <div className="mt-1 text-2xl font-extrabold">{renting ? "Rent it" : "Buy it"}</div>
          <p className="mt-1 text-sm text-muted">
            {renting
              ? `Renting saves about ${usd(diff)}/mo vs. the breakeven.`
              : `Buying saves about ${usd(diff)}/mo vs. renting.`}
          </p>
        </div>
        <Stat label="Breakeven rent" value={`${usd(result.breakevenRent)}/mo`} sub="buy wins above this" />
        <Stat
          label="Breakeven horizon"
          value={result.breakevenYear == null ? "Never" : monthsAndYears(result.breakevenYear)}
          sub={result.breakevenYear == null ? "owning never catches up" : "stay longer, buying wins"}
        />
      </div>
      <div className="grid grid-cols-2 border-t border-line bg-surface/60 sm:grid-cols-4">
        <MiniStat label="Monthly payment" value={usd(result.monthlyPayment)} />
        <MiniStat label="Loan amount" value={usd(result.loanAmount)} />
        <MiniStat label={`Net cost to buy (${inputs.yearsToStay}y)`} value={usd(result.buyNetCost)} />
        <MiniStat label={`Net cost to rent (${inputs.yearsToStay}y)`} value={usd(result.rentNetCost)} />
      </div>
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
        <span className="h-2.5 w-2.5 rounded-full bg-buy" /> Buying
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rent" /> Renting
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
