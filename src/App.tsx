import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { calculate, housingPaymentLines, type CalcInputs, type CalcResult } from "./engine/calculator";
import { CHART_HEIGHT_CLASS } from "./components/chart/ChartFrame";
import { useInView } from "./lib/useInView";
import { buildInputs, type AppInputs } from "./engine/defaults";
import { estimateMarginalRate, estimateStateIncomeTax, estimateTakeHome } from "./engine/taxRates";
import { Controls } from "./components/Controls";
import { type ActiveZip } from "./components/LocationPicker";
import { lookupZip, type ZipData } from "./lib/zips";
import { Breakdown } from "./components/Breakdown";
import { Derivation } from "./components/Derivation";
import { Disclosure, InfoTip, MoneyInput, Segmented } from "./ui";
import { CAPITAL_GAINS_EXCLUSION, MORTGAGE_INTEREST_DEBT_CAP, saltCapForYear, TAX_YEAR } from "./engine/taxConstants";
import { yearsLabel, pct, usd } from "./lib/format";
import { freshness } from "./lib/freshness";
import { decodeShare, encodeShare } from "./lib/share";
import { computeSensitivity, drivingFactor } from "./lib/sensitivity";
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
import type { LocationData, MarketData } from "./data/types";
import { insurance, locations, market as bundledMarket, propertyTax, usHome } from "./data/rates";


// Recharts (+d3) is ~half the bundle and only used below the fold, so load it
// lazily off the critical path. The four charts share one chunk; ChartCard gates each
// behind an IntersectionObserver so the chunk only loads once a chart nears the viewport.
const NetWorthChart = lazy(() => import("./components/NetWorthChart").then((m) => ({ default: m.NetWorthChart })));
const AdvantageChart = lazy(() =>
  import("./components/AdvantageChart").then((m) => ({ default: m.AdvantageChart })),
);
const CostCompositionChart = lazy(() =>
  import("./components/CostCompositionChart").then((m) => ({ default: m.CostCompositionChart })),
);
const MonthlyCostChart = lazy(() =>
  import("./components/MonthlyCostChart").then((m) => ({ default: m.MonthlyCostChart })),
);
const SensitivityChart = lazy(() =>
  import("./components/SensitivityChart").then((m) => ({ default: m.SensitivityChart })),
);

const METRO_KEY = "bow:metro"; // last selected metro (detected or chosen)
const HOME_KEY = "bow:home"; // the auto-detected locale, never overwritten by manual picks
const OVERRIDES_KEY = "bow:overrides";
const ZIP_KEY = "bow:zip"; // the active ZIP refinement's label (numbers ride in overrides)

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

// The active ZIP refinement is just a display label (the home value + rent it set ride in
// the overrides). Persisted so a reload keeps label and numbers in sync; cleared whenever
// a metro is chosen or the page is reset.
function storedZip(): ActiveZip | null {
  try {
    const raw = localStorage.getItem(ZIP_KEY);
    if (raw) {
      const z = JSON.parse(raw) as Partial<ActiveZip>;
      if (
        z &&
        typeof z.zip === "string" &&
        typeof z.city === "string" &&
        typeof z.state === "string" &&
        typeof z.homeValue === "number" &&
        typeof z.rent === "number"
      ) {
        return {
          zip: z.zip,
          city: z.city,
          state: z.state,
          homeValue: z.homeValue,
          rent: z.rent,
          appreciation5yr: typeof z.appreciation5yr === "number" ? z.appreciation5yr : undefined,
        };
      }
    }
  } catch {
    /* storage unavailable or malformed */
  }
  return null;
}

function saveActiveZip(z: ActiveZip | null) {
  try {
    if (z) localStorage.setItem(ZIP_KEY, JSON.stringify(z));
    else localStorage.removeItem(ZIP_KEY);
  } catch {
    /* storage unavailable */
  }
}

// The wordmark is "go home": a full reset back to the main page, your detected city,
// and every input at its default. Drop remembered edits, point the stored metro at the
// detected home (or clear it so the root re-detects), then hard-navigate to / so the
// URL, tab title, and all state rebuild from scratch instead of lingering on /metro.
function goHome() {
  try {
    saveOverrides({});
    saveActiveZip(null);
    const home = localStorage.getItem(HOME_KEY);
    if (home) localStorage.setItem(METRO_KEY, home);
    else localStorage.removeItem(METRO_KEY);
  } catch {
    /* storage unavailable */
  }
  window.location.assign("/");
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
    const ref = buildInputs(usHome, bundledMarket, propertyTax, insurance);
    return { loc, overrides: overridesFromShare(payload.o ?? {}, ref) };
  } catch {
    return null;
  }
}

// Decoded once at module load (before first render) so the initial state can use it.
const SHARE = typeof window !== "undefined" ? readShareLink() : null;

// Reflect the current place in the URL (/houston-tx or /77079) so it's copyable and
// bookmarkable, without a reload. Root for the national view. Skipped while viewing a
// ?s= share link, whose token in the query string is the authoritative URL.
function setPathSlug(slug: string) {
  try {
    if (window.location.search) return; // don't clobber a ?s= share URL
    const target = slug ? `/${slug}` : "/";
    if (window.location.pathname !== target) window.history.pushState(null, "", target);
  } catch {
    /* history unavailable */
  }
}

export function App({ initialMetroSlug, initialZip }: { initialMetroSlug?: string; initialZip?: string } = {}) {
  // A /metro-id deep-link (e.g. /houston-tx) opens the calculator pre-set to that metro,
  // fresh from its defaults (no stored edits). A ?s= share link still wins over it.
  const urlMetro = initialMetroSlug ? locations.find((l) => l.id === initialMetroSlug) : undefined;
  const startLoc = SHARE ? SHARE.loc : (urlMetro ?? storedLocation());
  // A /metro or /zip deep-link starts fresh (no stored edits); a ?s= share link wins over both.
  const overrides = useRef<Partial<AppInputs>>(SHARE ? SHARE.overrides : urlMetro || initialZip ? {} : loadOverrides());
  // A share link or deep-link dictates the place, so a stored ZIP label can't apply. A /zip
  // deep-link's label is set by the async lookup effect below once zips.json loads.
  const [activeZip, setActiveZip] = useState<ActiveZip | null>(() =>
    SHARE || urlMetro || initialZip ? null : storedZip(),
  );
  // While viewing a ?s= share link, don't write to the visitor's own localStorage;
  // the link is authoritative for the page and Reset exits the shared view.
  const shareActive = useRef(SHARE != null);
  const [copied, setCopied] = useState(false);
  const [justReset, setJustReset] = useState(false);
  // A dedicated polite region for the Share/Reset confirmations, kept separate from the
  // verdict announcer so the two can't clobber each other's messages.
  const [actionMsg, setActionMsg] = useState("");
  // True once the user edits any input; gates the one-time re-seed from live data.
  const touched = useRef(false);
  const [market, setMarket] = useState<MarketData>(() => bundledMarket);
  const [selected, setSelected] = useState<LocationData>(() => startLoc);
  const [inputs, setInputs] = useState<AppInputs>(() => ({
    ...buildInputs(startLoc, bundledMarket, propertyTax, insurance),
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
  const inputsForCalc = useMemo<AppInputs>(() => {
    if (!inputs.taxAuto || inputs.annualIncome <= 0) return inputs;
    const est = estimateMarginalRate(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
    const stateSalt = estimateStateIncomeTax(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
    return { ...inputs, marginalTaxRate: est.federal, otherSALT: stateSalt };
  }, [inputs]);

  const result = useMemo(() => calculate(inputsForCalc), [inputsForCalc]);

  // Charts read a DEFERRED copy of the result so a slider drag updates the headline number
  // every frame while the (heavier to re-render) SVG charts settle one frame behind. During an
  // urgent drag React hands back the previous result by reference, so the memoized chart
  // components bail their whole subtree instead of reconciling three charts per frame.
  const deferredResult = useDeferredValue(result);

  // The tornado data, computed once here so the chart and the plain-English "what your
  // verdict leans on" callout read identical numbers. It runs ~12 full engine sweeps, so we
  // defer it off the input hot path: dragging a slider updates the headline instantly and
  // this settles just after, which is fine since both readers live below the fold.
  const deferredInputs = useDeferredValue(inputsForCalc);
  const sensitivity = useMemo(() => computeSensitivity(deferredInputs), [deferredInputs]);
  const driver = drivingFactor(sensitivity);
  // How many assumptions can flip the verdict on their own (their breakeven range straddles your
  // rent). The callouts report this count instead of claiming a single "the one".
  const flipCount = sensitivity.filter((r) => r.flips).length;

  // Monthly owning-vs-renting chart: show the owning line net of the tax benefit by default,
  // toggleable to the gross (pre-benefit) figure.
  const [ownNet, setOwnNet] = useState(true);

  // A ZIP refinement relabels the place to that ZIP's real city, so the headline, picker,
  // and share text never show the old metro name over the ZIP's numbers.
  const displayMetro = activeZip ? `${activeZip.city}, ${activeZip.state}` : selected.metro;

  // Announce the verdict to screen readers, debounced ~600ms so dragging a slider
  // doesn't fire a stream of interruptions: the polite region speaks once the numbers
  // settle. (Sighted users already see the live headline update.)
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    const word = isCloseCall(result, inputs)
      ? "Basically a toss-up"
      : result.verdict === "rent"
        ? "Renting wins"
        : "Buying wins";
    const id = window.setTimeout(
      () => setAnnounce(`${word}. Breakeven rent ${usd(result.breakevenRent)} a month.`),
      600,
    );
    return () => window.clearTimeout(id);
  }, [result, inputs]);

  // A /metro deep-link gets a metro-specific tab title (the static HTML still carries
  // the generic one for crawlers until the per-metro prerender lands).
  useEffect(() => {
    if (urlMetro) document.title = `Rent vs. buy in ${urlMetro.metro} | breakEven`;
  }, [urlMetro]);

  // A /zip deep-link can't apply synchronously (zips.json is lazy), so resolve it once on
  // mount and apply the ZIP's numbers + label. A ?s= share link or /metro slug wins.
  useEffect(() => {
    if (!initialZip || SHARE || urlMetro) return;
    let cancelled = false;
    lookupZip(initialZip).then((data) => {
      if (cancelled || !data) return;
      selectZip(initialZip, data); // the URL already names this ZIP, so don't push again
      document.title = `Rent vs. buy in ${data.city}, ${data.state} | breakEven`;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Back/forward through metro/zip selections: re-apply whatever place the URL now names.
  useEffect(() => {
    function onPop() {
      const slug = window.location.pathname.replace(/^\/+|\/+$/g, "");
      if (/^\d{5}$/.test(slug)) {
        lookupZip(slug).then((data) => data && selectZip(slug, data));
      } else {
        const loc = slug ? locations.find((l) => l.id === slug) : usHome;
        if (loc) selectLocation(loc, true);
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Mirror the current selection in a ref so async geo callbacks can tell whether
  // the user has moved on since they were kicked off (avoids yanking the location).
  const selectedRef = useRef(selected.id);
  useEffect(() => {
    selectedRef.current = selected.id;
  }, [selected]);

  // Latest inputs, for handlers invoked from mount-only effects (popstate, the /zip lookup).
  // Those effects capture first-render closures, so reading `inputs` directly there would see
  // stale values; selectZip reads the current cost-basis kinds off this ref instead.
  const inputsRef = useRef(inputs);
  useEffect(() => {
    inputsRef.current = inputs;
  }, [inputs]);

  // Manual edits from the controls. Persist the ones we remember.
  const patch = (p: Partial<AppInputs>) => {
    touched.current = true;
    setInputs((prev) => ({ ...prev, ...p }));
    const changed = rememberOverrides(overrides.current, p);
    if (changed && !shareActive.current) saveOverrides(overrides.current);
  };

  function selectLocation(loc: LocationData, remember = true, updateUrl = false) {
    setSelected(loc);
    if (updateUrl) setPathSlug(loc.id === "united-states" ? "" : loc.id);
    // Picking a metro leaves any ZIP refinement behind.
    setActiveZip(null);
    if (!shareActive.current) saveActiveZip(null);
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

  // Choosing a ZIP rides as home-price + rent overrides (so it persists and shares like any
  // edit) plus a label, so the picker and headline show the ZIP's real city instead of the
  // old metro name. Property tax stays on the metro's state rate but scales with the value.
  function selectZip(zip: string, data: ZipData, updateUrl = false) {
    // Re-point the rate-based costs and the SALT state to the ZIP's state (like
    // selectLocation), so an out-of-state ZIP doesn't tax a CA home at TX rates. These ride
    // as overrides too, so they persist, share, and get pruned on a metro switch. A
    // flat-dollar figure the user typed is personal, so it's left alone.
    const p: Partial<AppInputs> = { homePrice: data.homeValue, monthlyRent: data.rent, taxState: data.state };
    const taxRate = propertyTax[data.state];
    const insRate = insurance[data.state];
    // Read the current basis kinds off the ref, not the closure: a popstate/zip-deep-link
    // call runs inside a mount-only effect that captured first-render inputs.
    const cur = inputsRef.current;
    if (cur.propertyTax.kind === "pctOfValue" && taxRate != null) p.propertyTax = { kind: "pctOfValue", rate: taxRate };
    if (cur.homeInsurance.kind === "pctOfValue" && insRate != null) p.homeInsurance = { kind: "pctOfValue", rate: insRate };
    patch(p);
    const z: ActiveZip = {
      zip,
      city: data.city,
      state: data.state,
      homeValue: data.homeValue,
      rent: data.rent,
      appreciation5yr: data.appreciation5yr,
    };
    setActiveZip(z);
    if (!shareActive.current) saveActiveZip(z);
    if (updateUrl) setPathSlug(zip);
  }

  // Jump to a location with its defaults (no manual overrides applied).
  function goTo(loc: LocationData) {
    setSelected(loc);
    setActiveZip(null);
    saveActiveZip(null);
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
    setActionMsg("Reset to your location defaults");
    window.setTimeout(() => {
      setJustReset(false);
      setActionMsg("");
    }, 1500);
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
  async function share() {
    const defaults = buildInputs(selected, market, propertyTax, insurance);
    const o = diffOverrides(inputs, defaults);
    const url = `${window.location.origin}${window.location.pathname}?s=${encodeShare({ m: selected.id, o })}`;
    const verb = isCloseCall(result, inputs)
      ? "it's basically a coin flip"
      : result.verdict === "rent"
        ? "renting wins"
        : "buying wins";
    const text = `Rent vs. buy in ${displayMetro}: at ${usd(inputs.monthlyRent)}/mo, ${verb}. Breakeven rent ${usd(result.breakevenRent)}/mo.`;

    // On touch devices the OS share sheet beats a silent clipboard copy. On desktop we
    // keep copying the bare link, which unfurls its own card when pasted into Discord,
    // Slack, or iMessage (and a coarse-pointer Chromebook still gets the nicer sheet).
    if (navigator.share && window.matchMedia?.("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title: "breakEven", text, url });
      } catch {
        /* user dismissed the share sheet, nothing to do */
      }
      return;
    }
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      setActionMsg("Link copied");
      window.setTimeout(() => {
        setCopied(false);
        setActionMsg("");
      }, 1800);
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
    if (SHARE || urlMetro || initialZip) return; // a share link or deep-link dictates the location
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
        <div aria-live="polite" className="sr-only">
          {announce}
        </div>
        <div aria-live="polite" className="sr-only">
          {actionMsg}
        </div>
        <Hero metro={displayMetro} result={result} inputs={inputs} />

        {/* On mobile the controls stack above the results, so surface a one-line
            verdict up top for immediate feedback (hidden on lg, where the full
            Verdict sits beside the controls). */}
        <div className="mt-4 lg:hidden">
          <CondensedVerdict result={result} inputs={inputs} />
        </div>

        <div className="mt-5 grid grid-cols-1 gap-6 lg:mt-6 lg:grid-cols-[minmax(0,380px)_1fr]">
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
              activeZip={activeZip}
              onSelectLocation={(loc) => selectLocation(loc, true, true)}
              onSelectZip={(zip, data) => selectZip(zip, data, true)}
              market={market}
            />
          </section>

          <section className="min-w-0 space-y-6">
            <Verdict result={result} inputs={inputs} driver={driver} flipCount={flipCount} />

            {/* Lead with the wealth chart right under the verdict so there's a real graph above
                the fold. What you're actually worth is the question people feel; the payment and
                cost views below explain how you get there. */}
            <ChartCard
              title="What you're worth, buying vs renting"
              legend={<Legend />}
              note={
                <>
                  Your wealth if you sold and moved out after each year. Buying is home equity after selling costs and
                  capital-gains tax. Renting is the down payment plus monthly savings, invested. They cross the same year
                  buying pulls ahead.
                </>
              }
            >
              <NetWorthChart
                data={deferredResult.netWorth}
                breakevenYear={deferredResult.breakevenYear}
                yearsToStay={deferredInputs.yearsToStay}
              />
            </ChartCard>

            <MonthlyPayment result={result} inputs={inputs} />

            <Affordability result={result} inputs={inputs} patch={patch} />

            <ChartCard
              title="Cost gap: how far ahead buying or renting is"
              legend={<AdvantageLegend />}
              note={
                <>
                  Cumulative net cost in today's dollars, plotted as the gap between renting and buying. Below zero
                  renting is ahead, above zero buying is. Where it crosses is the year buying takes the lead. Tap or hover
                  for the running total on each side.
                </>
              }
            >
              <AdvantageChart
                data={deferredResult.horizon}
                breakevenYear={deferredResult.breakevenYear}
                yearsToStay={deferredInputs.yearsToStay}
              />
            </ChartCard>

            <ChartCard
              title="Where each year's payment goes"
              note={
                inputs.yearsToStay === 1 ? (
                  <>
                    Your one year of owning, split into where the money lands. Most of an early payment is interest; the
                    principal slice (green) is the part that builds equity instead of vanishing.
                  </>
                ) : (
                  <>
                    Every year you own, split into where the money lands. Interest dominates early and fades as principal
                    (which builds equity, not a sunk cost) takes over across your stay.
                  </>
                )
              }
            >
              <CostCompositionChart years={deferredResult.years} />
            </ChartCard>

            <ChartCard
              title="Monthly cost: owning vs renting"
              legend={
                <Segmented
                  ariaLabel="Whether to include the mortgage tax break in the owning cost"
                  value={ownNet ? "net" : "gross"}
                  onChange={(v) => setOwnNet(v === "net")}
                  options={[
                    { label: "With tax break", value: "net" },
                    { label: "Without", value: "gross" },
                  ]}
                />
              }
              note={
                <>
                  Your all-in monthly cost of owning (mortgage, property tax, insurance, maintenance, plus any HOA and
                  PMI){ownNet ? " less the mortgage-interest and SALT tax break" : ""}, against the rent that year. Owning
                  holds roughly steady while rent climbs, so where they cross is when renting starts costing more each
                  month.
                </>
              }
            >
              <MonthlyCostChart years={deferredResult.years} net={ownNet} />
            </ChartCard>

            <ChartCard
              title="What actually moves the answer"
              lead={
                driver && (
                  <p className="mt-1 text-sm font-medium text-ink">
                    {flipCount === 0 ? (
                      <>
                        Even the widest swing, <span className="font-semibold">{driver.label.toLowerCase()}</span>, keeps
                        the verdict the same across a realistic range, so this call is pretty robust.
                      </>
                    ) : flipCount === 1 ? (
                      <>
                        Your verdict leans hardest on{" "}
                        <span className="font-semibold">{driver.label.toLowerCase()}</span>, the one assumption here that
                        could flip it on its own.
                      </>
                    ) : (
                      <>
                        Close enough that {flipCount} of these assumptions could each flip it on their own,{" "}
                        <span className="font-semibold">{driver.label.toLowerCase()}</span> most of all.
                      </>
                    )}
                  </p>
                )
              }
              note={
                <>
                  Each bar sweeps one assumption across a realistic range and plots where the breakeven rent (the rent at
                  which buying and renting tie) lands. A bar sitting left of your rent line means buying wins at that
                  assumption; right of it, renting wins. The widest bars are what the verdict hangs on, and any bar
                  straddling your rent line could flip it.
                </>
              }
            >
              <SensitivityChart rows={sensitivity} monthlyRent={deferredInputs.monthlyRent} />
            </ChartCard>
          </section>
        </div>

        {/* Full-width so the wide tables have room to breathe. */}
        <div className="mt-6 space-y-3">
          <Disclosure summary="How your rates are derived">
            <Derivation inputs={inputs} result={result} market={market} selected={selected} activeZip={activeZip} />
          </Disclosure>
          <Disclosure summary="Year-by-year breakdown">
            <Breakdown
              result={result}
              inputs={inputsForCalc}
              placeLabel={activeZip ? `ZIP ${activeZip.zip} (${activeZip.city}, ${activeZip.state})` : selected.metro}
              placeId={activeZip ? activeZip.zip : selected.id}
              dataAsOf={market.asOf}
            />
          </Disclosure>
        </div>

        <Sources market={market} />
      </main>
    </div>
  );
}

function Header({ market }: { market: MarketData }) {
  // The refresh cron can silently stall (its push is continue-on-error), so age the badge
  // out instead of labeling week-old numbers "fresh", and show it on mobile too.
  const fresh = freshness(market.asOf, new Date());
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-paper/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-2">
          <a
            href="/"
            onClick={(e) => {
              // Plain left-click resets in place; let modified clicks open / normally.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              goHome();
            }}
            title="Reset to your city and defaults"
            className="rounded text-lg font-extrabold tracking-tight transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
          >
            <span className="text-rent">break</span>
            <span className="text-buy">Even</span>
          </a>
          <span className="hidden text-sm text-muted sm:inline">rent vs. buy, with the math shown</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          {fresh.stale ? (
            <span
              className="inline-flex items-center gap-1 font-medium text-warn-text"
              title={`Live data last refreshed ${fresh.asOf}. The weekly sync may have stalled, so these numbers could be out of date.`}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-3.5 w-3.5">
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 7.5a.75.75 0 01.75.75v2.5a.75.75 0 01-1.5 0v-2.5A.75.75 0 0110 7.5zm0 6.5a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="hidden sm:inline">data may be stale, as of {fresh.asOf}</span>
              <span className="sm:hidden">stale · {fresh.asOf}</span>
            </span>
          ) : (
            <span>
              data <span className="hidden sm:inline">fresh as of </span>
              <span className="font-semibold text-ink">{fresh.asOf}</span>
            </span>
          )}
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

function Hero({ metro, result, inputs }: { metro: string; result: CalcResult; inputs: AppInputs }) {
  const renting = result.verdict === "rent";
  // Honor the same close-call threshold the Verdict card and announcer use, so the giant
  // headline can't shout a winner while the card right below it reads "Toss-up".
  const closeCall = isCloseCall(result, inputs);
  return (
    <div className="pt-4 sm:pt-6">
      <p className="text-sm font-semibold uppercase tracking-wide text-muted">
        Should you rent or buy in {metro}?
      </p>
      <h1 className="mt-2 max-w-3xl text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
        {closeCall ? (
          <>
            At <span className="text-ink">{usd(inputs.monthlyRent)}/mo</span> rent, it's basically a toss-up.
          </>
        ) : renting ? (
          <>
            At <span className="text-rent">{usd(inputs.monthlyRent)}/mo</span> rent, renting comes out ahead.
          </>
        ) : (
          <>
            At <span className="text-buy">{usd(inputs.monthlyRent)}/mo</span> rent, buying comes out ahead.
          </>
        )}
      </h1>
    </div>
  );
}

// Within 5% of the breakeven the verdict is a near-tie; below that the gap reads
// like a real rent-vs-buy advantage worth naming.
const isCloseCall = (result: CalcResult, inputs: CalcInputs) =>
  Math.abs(result.monthlyDifference) < inputs.monthlyRent * 0.05;

// The conventional 28/36 underwriting rule of thumb: lenders like housing costs at or under 28%
// of gross monthly income (front-end), and total debt (housing plus car/student/card payments)
// at or under 36% (back-end). Many programs stretch the back-end to ~43%, but 36% is the
// comfortable line the affordability panel measures against.
const DTI_FRONT_END_LIMIT = 0.28;
const DTI_BACK_END_LIMIT = 0.36;
const verdictLabel = (result: CalcResult, inputs: CalcInputs) =>
  isCloseCall(result, inputs) ? "Toss-up" : result.verdict === "rent" ? "Rent it" : "Buy it";

// A one-line verdict for mobile, shown above the controls so there's immediate
// feedback without scrolling past every input first.
function CondensedVerdict({ result, inputs }: { result: CalcResult; inputs: AppInputs }) {
  const renting = result.verdict === "rent";
  // A toss-up stays neutral (line border, surface fill, muted eyebrow) so the card chrome
  // doesn't shout a winner the headline refuses to pick. Mirrors Hero and SimpleCalc.
  const closeCall = isCloseCall(result, inputs);
  return (
    <div
      className={
        "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-sm " +
        (closeCall ? "border-line bg-surface" : renting ? "border-rent/30 bg-rent-soft/40" : "border-buy/30 bg-buy-soft/40")
      }
    >
      <div>
        <div
          className={
            "text-[11px] font-bold uppercase tracking-wide " +
            (closeCall ? "text-muted" : renting ? "text-rent-text" : "text-buy-text")
          }
        >
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

function Verdict({
  result,
  inputs,
  driver,
  flipCount,
}: {
  result: CalcResult;
  inputs: AppInputs;
  driver: ReturnType<typeof drivingFactor>;
  flipCount: number;
}) {
  const renting = result.verdict === "rent";
  const diff = Math.abs(result.monthlyDifference);
  const closeCall = isCloseCall(result, inputs);
  // Cash due at the signing table, the number every monthly comparison quietly skips:
  // down payment + closing costs to buy, deposit + broker fee to rent.
  const buyUpfront = inputs.homePrice * (inputs.downPaymentPct + inputs.buyingClosingPct);
  const rentUpfront = inputs.monthlyRent * (inputs.securityDepositMonths + inputs.brokerFeeMonths);
  return (
    <div
      className={
        "overflow-hidden rounded-2xl border shadow-sm " +
        (closeCall ? "border-line bg-surface" : renting ? "border-rent/30 bg-rent-soft/40" : "border-buy/30 bg-buy-soft/40")
      }
    >
      <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="p-5 sm:p-6">
          <div
            className={
              "text-xs font-bold uppercase tracking-wide " +
              (closeCall ? "text-muted" : renting ? "text-rent-text" : "text-buy-text")
            }
          >
            Verdict
          </div>
          <div className="mt-1 text-2xl font-extrabold">{verdictLabel(result, inputs)}</div>
          <p className="mt-1 text-sm text-muted">
            {closeCall
              ? "Basically a wash, it comes down to a few assumptions."
              : renting
                ? `Your rent is ${usd(diff)}/mo under the breakeven rent, so renting comes out ahead.`
                : `Your rent is ${usd(diff)}/mo over the breakeven rent, so buying comes out ahead.`}
          </p>
          {driver && (
            <p className="mt-2 text-xs text-muted">
              {flipCount === 0 ? (
                <>
                  Pretty robust: even <span className="font-semibold text-ink">{driver.label.toLowerCase()}</span>, the
                  biggest lever, doesn't flip it.
                </>
              ) : flipCount === 1 ? (
                <>
                  Hinges on <span className="font-semibold text-ink">{driver.label.toLowerCase()}</span>, the one
                  assumption that could flip the answer on its own.
                </>
              ) : (
                <>
                  A close call: {flipCount} assumptions could each flip it,{" "}
                  <span className="font-semibold text-ink">{driver.label.toLowerCase()}</span> most of all.
                </>
              )}
            </p>
          )}
          <p className="mt-3 border-t border-line pt-3 text-sm text-muted">
            <span className="font-semibold text-ink">{usd(buyUpfront)}</span> in cash to buy today
            {rentUpfront > 0 ? (
              <>
                , vs <span className="font-semibold text-ink">{usd(rentUpfront)}</span> to rent
              </>
            ) : null}
            .
          </p>
        </div>
        <Stat label="Breakeven rent" value={`${usd(result.breakevenRent)}/mo`} sub="buying wins above this rent" />
        <Stat
          label="Breakeven horizon"
          value={result.breakevenYear == null ? "Never" : yearsLabel(result.breakevenYear)}
          sub={result.breakevenYear == null ? "owning never catches up" : "stay longer, buying wins"}
        />
      </div>
      <div className="grid grid-cols-2 border-t border-line bg-surface/60 sm:grid-cols-4">
        <MiniStat
          label="Mortgage / mo"
          value={usd(result.monthlyPayment)}
          hint="Principal and interest only. Property tax, insurance, HOA, and PMI are on top, see the net effective monthly payment below."
        />
        <MiniStat label="Loan amount" value={usd(result.loanAmount)} />
        <MiniStat label={`Buy total · ${inputs.yearsToStay}yr`} value={usd(result.buyNetCost)} />
        <MiniStat label={`Rent total · ${inputs.yearsToStay}yr`} value={usd(result.rentNetCost)} />
      </div>
    </div>
  );
}

// Zillow-style payment breakdown, but netting out the federal tax benefit to a
// "net effective" monthly figure (Year 1) so the affordability picture is honest.
// The headline says what it is; the itemized lines live behind an expander. The
// income/DTI side of affordability lives in the Affordability panel below, not here.
function MonthlyPayment({ result, inputs }: { result: CalcResult; inputs: CalcInputs }) {
  const [open, setOpen] = useState(false);
  const y1 = result.years[0];
  if (!y1) return null;
  // pni = principal & interest; gross = the all-in monthly housing payment; net = gross minus
  // the Year-1 federal tax benefit. The headline shows net; affordability is judged on gross.
  const pni = result.monthlyPayment;
  const taxBenefit = y1.taxBenefit / 12;
  // Escrow-style carrying costs straight from the registry, so a new one flows into
  // the headline automatically (maintenance is excluded by not being flagged).
  const lines = housingPaymentLines(y1).filter((l) => l.monthly > 0);
  const gross = pni + lines.reduce((s, l) => s + l.monthly, 0);
  const net = gross - taxBenefit;
  // The comparison the whole app exists to make: this owning payment against the rent it
  // replaces. Principal is still buried inside the owning figure, hence "before any equity".
  const rent = inputs.monthlyRent;
  const delta = net - rent;
  const rows: { label: string; value: number; credit?: boolean }[] = [
    { label: "Principal & interest", value: pni },
    ...lines.map((l) => ({ label: l.label, value: l.monthly })),
    ...(taxBenefit > 0 ? [{ label: "Tax benefit", value: taxBenefit, credit: true }] : []),
  ];

  // The "what is this figure" prose lives in a tooltip on the headline now, so the card stays
  // scannable while the gross (pre-tax-benefit) figure is still one tap away.
  const explain =
    taxBenefit > 0
      ? `All-in year-1 housing (principal & interest, property tax, insurance, plus any HOA and PMI), minus the estimated federal tax benefit from itemizing mortgage interest and SALT over the standard deduction. ${usd(gross)}/mo before that benefit.`
      : "All-in year-1 housing (principal & interest, property tax, insurance, plus any HOA and PMI). Itemizing doesn't beat the standard deduction at these numbers, so there's no tax benefit to net out.";

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="inline-flex items-center text-base font-bold">
          Net effective monthly payment
          <InfoTip text={explain} />
        </h3>
        <div className="text-right">
          <span className="tnum text-2xl font-extrabold">{usd(net)}</span>
          <span className="text-base font-semibold text-muted">/mo</span>
        </div>
      </div>
      {rent > 0 && (
        <p className="mt-1.5 text-sm text-muted">
          {Math.abs(delta) < 15 ? (
            <>
              About the same monthly as renting (<span className="font-semibold text-ink">{usd(rent)}/mo</span>), before
              you build any equity.
            </>
          ) : delta > 0 ? (
            <>
              <span className="font-semibold text-ink">{usd(delta)}/mo more</span> than renting (
              <span className="font-semibold text-ink">{usd(rent)}/mo</span>), before you build any equity.
            </>
          ) : (
            <>
              <span className="font-semibold text-ink">{usd(-delta)}/mo less</span> than renting (
              <span className="font-semibold text-ink">{usd(rent)}/mo</span>), and you still build equity.
            </>
          )}
        </p>
      )}
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

// One labeled line in the income ledger: label left, dollar figure right. `negative` mutes it
// and prefixes a minus (a deduction); `total` bolds it and sets it off under a divider (a subtotal).
function LedgerRow({
  label,
  hint,
  value,
  negative,
  total,
}: {
  label: string;
  hint?: string;
  value: string;
  negative?: boolean;
  total?: boolean;
}) {
  return (
    <div className={"flex items-baseline justify-between gap-3" + (total ? " border-t border-line/60 pt-2" : "")}>
      <dt className={"text-sm " + (total ? "font-semibold text-ink" : "text-muted")}>
        {label}
        {hint && <span className="ml-1 font-normal text-muted">{hint}</span>}
      </dt>
      <dd className={"tnum text-sm font-semibold " + (negative ? "text-muted" : "text-ink")}>
        {negative ? `-${value}` : value}
      </dd>
    </div>
  );
}

// A housing / total-debt line with its DTI ratio underneath: amount on the right, then a small
// caption naming the percent of gross income and whether it clears the 28%/36% line (amber if over).
function RatioRow({
  label,
  hint,
  amount,
  pct: ratioPct,
  over,
  limit,
  total,
}: {
  label: string;
  hint?: string;
  amount: string;
  pct: number;
  over: boolean;
  limit: number;
  total?: boolean;
}) {
  return (
    <div className={total ? "border-t border-line/60 pt-2" : ""}>
      <div className="flex items-baseline justify-between gap-3">
        <dt className={"text-sm " + (total ? "font-semibold text-ink" : "text-muted")}>
          {label}
          {hint && <span className="ml-1 font-normal text-muted">{hint}</span>}
        </dt>
        <dd className="tnum text-sm font-semibold text-ink">{amount}/mo</dd>
      </div>
      <p className={"tnum mt-0.5 text-xs " + (over ? "font-medium text-warn-text" : "text-muted")}>
        {ratioPct}% of gross income · {over ? `over the ${limit}% line` : `under the ${limit}% line`}
      </p>
    </div>
  );
}

// A plain-language affordability walkthrough: gross income, what's left after estimated taxes, and
// how the all-in housing payment (plus any other debt) sits against the 28% front-end and 36%
// back-end ratios lenders underwrite to. Rendered only when an income is entered and the purchase
// is financed (an all-cash buy has no lender ratio), so the default view stays uncluttered.
function Affordability({
  result,
  inputs,
  patch,
}: {
  result: CalcResult;
  inputs: AppInputs;
  patch: (p: Partial<AppInputs>) => void;
}) {
  const y1 = result.years[0];
  const income = inputs.annualIncome;
  if (!y1 || income <= 0 || result.loanAmount <= 0) return null;

  // Gross PITI: the all-in housing payment lenders qualify against (before any tax benefit),
  // built the same way as the payment card's gross figure.
  const lines = housingPaymentLines(y1).filter((l) => l.monthly > 0);
  const housing = result.monthlyPayment + lines.reduce((s, l) => s + l.monthly, 0);

  const grossMonthly = income / 12;
  const { incomeTax, fica, takeHome } = estimateTakeHome(income, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
  const takeHomeMonthly = takeHome / 12;

  const debt = inputs.otherMonthlyDebt;
  const totalDebt = housing + debt;
  // Round once and branch on the rounded value so the shown percent and the over/under verdict
  // agree at the boundary (a 28.4% that displays "28%" shouldn't also read as "over the line").
  const frontPct = Math.round((housing / grossMonthly) * 100);
  const backPct = Math.round((totalDebt / grossMonthly) * 100);
  const frontOver = frontPct > DTI_FRONT_END_LIMIT * 100;
  const backOver = backPct > DTI_BACK_END_LIMIT * 100;
  const overGuideline = frontOver || backOver;
  // The budget-side view lenders ignore: the share of actual take-home the housing payment eats.
  const takeHomeShare = takeHomeMonthly > 0 ? Math.round((housing / takeHomeMonthly) * 100) : null;

  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
      <h3 className="text-base font-bold">Can you afford it?</h3>
      <p className="mt-1 text-sm text-muted">
        What your income looks like after estimated taxes, and how the payment stacks up against the ratios lenders
        underwrite to.
      </p>

      <dl className="mt-4 space-y-2">
        <LedgerRow label="Gross monthly income" value={usd(grossMonthly)} />
        <LedgerRow label="Income tax" hint="est." value={usd(incomeTax / 12)} negative />
        <LedgerRow label="Payroll (FICA)" value={usd(fica / 12)} negative />
        <LedgerRow label="Take-home" value={usd(takeHomeMonthly)} total />
      </dl>

      <dl className="mt-4 space-y-2 border-t border-line/60 pt-4">
        <RatioRow label="Housing payment" hint="PITI" amount={usd(housing)} pct={frontPct} over={frontOver} limit={28} />
        <div className="flex items-center justify-between gap-3">
          <dt className="text-sm text-muted">
            Other monthly debt<span className="ml-1 font-normal text-muted">car, loans, cards</span>
          </dt>
          <dd className="w-28 shrink-0">
            <MoneyInput
              value={debt}
              onChange={(n) => patch({ otherMonthlyDebt: n })}
              step={50}
              placeholder="0"
              ariaLabel="Other monthly debt"
            />
          </dd>
        </div>
        <RatioRow label="Total monthly debt" amount={usd(totalDebt)} pct={backPct} over={backOver} limit={36} total />
      </dl>

      <p className="mt-3 text-sm text-muted">
        {overGuideline ? (
          <>
            <span className="font-medium text-warn-text">Above the 28/36 guideline</span> lenders like to see, so this
            may stretch the budget.
          </>
        ) : (
          <>Comfortably inside the 28/36 guideline lenders like to see.</>
        )}
        {takeHomeShare != null && <> The payment is {takeHomeShare}% of your take-home pay.</>}
        {overGuideline && result.verdict === "rent" && (
          <> Renting also comes out ahead here, so stretching for this isn't buying you a better deal.</>
        )}
      </p>
      <p className="mt-2 text-xs text-muted">
        Take-home is an estimate: federal, state, and local income tax plus employee FICA, assuming W-2 wages. Lenders
        measure these ratios against gross income; the take-home line is just your budget's view. Not financial advice.
      </p>
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

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="px-5 py-3">
      <div className="flex items-center text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
        {hint && <InfoTip text={hint} />}
      </div>
      <div className="tnum text-sm font-bold">{value}</div>
    </div>
  );
}

/**
 * The shared scaffold every chart card repeats: the rounded card, an h3 (with an optional
 * legend on the same baseline), an optional lead paragraph, the muted note, and a Suspense
 * boundary gated behind useInView so the lazy chart (and the recharts chunk) only mounts once
 * the card scrolls near the viewport. The placeholder reserves the chart's height both before
 * it enters view and while the chunk loads, so there's no layout shift.
 */
function ChartCard({
  title,
  legend,
  lead,
  note,
  children,
}: {
  title: string;
  legend?: ReactNode;
  lead?: ReactNode;
  note: ReactNode;
  children: ReactNode;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
      {legend ? (
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-bold">{title}</h3>
          {legend}
        </div>
      ) : (
        <h3 className="text-base font-bold">{title}</h3>
      )}
      {lead}
      <p className={legend ? "mb-4 text-sm text-muted" : "mb-4 mt-1 text-sm text-muted"}>{note}</p>
      <div ref={ref}>
        <Suspense fallback={<div className={CHART_HEIGHT_CLASS} />}>
          {inView ? children : <div className={CHART_HEIGHT_CLASS} />}
        </Suspense>
      </div>
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
  // Triangles (up vs down) carry the meaning by shape as well as color, so the orange/teal pair
  // stays legible for colorblind readers, and they echo the chart's above/below-the-line split.
  return (
    <div className="flex items-center gap-4 text-xs">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-buy">&#9650;</span> Buying ahead
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-rent">&#9660;</span> Renting ahead
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
      value: `Zillow ZHVI / single-family ZORI (${market.national.asOf})`,
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
          rather than recent local run-ups. The rent figure is Zillow's single-family ZORI, what a comparable house
          rents for, not the cheaper apartment-blended index, so the comparison is house against house. Zillow
          publishes single-family rent for metros but not ZIPs, so a ZIP-refined rent is an estimate (its blended rent
          scaled by that metro's single-family premium). ZORI tracks newly-listed asking rents, which run ahead of what
          a tenant renewing in place pays, so in a hot market it may read high. Adjust any input to your own numbers.
          This is a decision aid, not financial advice.
        </p>
        <p className="pt-2">
          Free and open source. Data refreshes automatically.{" "}
          <a href="https://github.com/swhitt/breakeven" className="font-semibold text-ink hover:underline">
            View the code and the model on GitHub.
          </a>
        </p>
      </div>

      <div className="mt-6 max-w-3xl">
        <Disclosure summary="The formulas, in full">
          <MethodologyFormulas />
        </Disclosure>
      </div>
    </footer>
  );
}

// The actual math, for readers who want it. Faithful to src/engine/calculator.ts: monthly
// simulation, present values discounted at the investment return, breakeven solved in closed
// form. Kept behind a disclosure so the default page stays approachable. The tax figures are
// interpolated from src/engine/taxConstants.ts (not retyped here) so a law change updates the
// panel automatically instead of leaving it quietly wrong.
function Formula({ children }: { children: ReactNode }) {
  return (
    <div className="my-2 overflow-x-auto rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink">
      {children}
    </div>
  );
}

function MethodologyFormulas() {
  const sections: { title: string; body: ReactNode }[] = [
    {
      title: "Present value of any stream",
      body: (
        <>
          Every monthly flow is discounted at <code className="text-ink">d = investmentReturn / 12</code>:
          <Formula>PV = Σ flow_m / (1 + d)^m</Formula>
          The down payment and closing costs sit at t = 0 (undiscounted); sale proceeds land at the horizon. Using your
          return as the discount rate is deliberate: certain flows (the mortgage) and uncertain ones (appreciation) are
          discounted alike, a known simplification.
        </>
      ),
    },
    {
      title: "Breakeven rent, in closed form (not a search)",
      body: (
        <>
          Renting's present cost is linear in the monthly rent r, since rent, the deposit, and the broker fee all scale
          with it:
          <Formula>PV_rent(r) = r · S + F</Formula>
          S is the rent-proportional slope (discounted rent plus deposit and broker fee, less the deposit returned at
          move-out); F is the fixed part (renters insurance). Buying's cost PV_buy does not depend on r, so the
          breakeven rent is a single division:
          <Formula>r* = (PV_buy - F) / S</Formula>
        </>
      ),
    },
    {
      title: "Owning cost, four buckets",
      body: (
        <>
          <Formula>PV_buy = (down + closing) + Σ (carry_m - taxBenefit_m)/(1+d)^m - saleProceeds/(1+d)^N</Formula>
          carry_m is mortgage (principal + interest) + property tax + maintenance + insurance + HOA + PMI (while loan /
          value &gt; 80%), each grown by inflation or appreciation. saleProceeds is the appreciated value less selling
          costs, the remaining loan balance, and capital-gains tax after the IRC section 121 exclusion (
          {usd(CAPITAL_GAINS_EXCLUSION.joint)} joint / {usd(CAPITAL_GAINS_EXCLUSION.single)} single).
        </>
      ),
    },
    {
      title: "Tax benefit (itemizing helps only on the excess)",
      body: (
        <>
          <Formula>benefit = fedRate · max(0, deductibleInterest + saltUsed - standardDeduction)</Formula>
          Interest is capped at the {usd(MORTGAGE_INTEREST_DEBT_CAP)} acquisition-debt fraction (rising toward 100% as
          the loan amortizes under the cap); saltUsed = min(property tax + state and local income tax,{" "}
          {usd(saltCapForYear(TAX_YEAR))} SALT cap, which steps down in later years under current law). Valued at your
          federal marginal rate, since it is a federal Schedule A deduction.
        </>
      ),
    },
    {
      title: "Net worth if you sell and move out",
      body: (
        <>
          The buyer's wealth is the sale proceeds (equity after selling costs and capital-gains tax). The renter invests
          the difference:
          <Formula>renterNetWorth = buyerNetWorth + (PV_buy - PV_rent) · (1 + d)^N</Formula>
          the down payment plus every month's cash-flow gap, compounded at your return. By construction the wealth lines
          cross the same year the cost lines do.
        </>
      ),
    },
  ];
  return (
    <div className="space-y-5 text-sm text-muted">
      <p>
        The engine is a pure function in <code className="text-ink">src/engine/calculator.ts</code>, simulated month by
        month. Here is exactly what it computes.
      </p>
      {sections.map((s) => (
        <div key={s.title}>
          <div className="font-semibold text-ink">{s.title}</div>
          <div className="mt-1">{s.body}</div>
        </div>
      ))}
    </div>
  );
}
