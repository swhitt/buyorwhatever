import { useEffect, useMemo, useRef, useState } from "react";
import { calculate, type CalcInputs } from "./engine/calculator";
import { buildInputs } from "./engine/defaults";
import { Controls } from "./components/Controls";
import { CrossoverChart } from "./components/CrossoverChart";
import { Breakdown } from "./components/Breakdown";
import { Disclosure } from "./ui";
import { monthsAndYears, pct, usd } from "./lib/format";
import { ThemeToggle } from "./theme";
import { detectMetro } from "./geo";
import type { LocationData, MarketData, PropertyTaxTable } from "./data/types";

import marketRaw from "./data/market.json";
import locationsRaw from "./data/locations.json";
import propertyTaxRaw from "./data/propertyTax.json";
import insuranceRaw from "./data/insurance.json";

const market = marketRaw as MarketData;
const locations = locationsRaw as LocationData[];
// The JSON carries _source/_asOf string metadata alongside the numeric rates,
// so cast through unknown; state-code lookups are unaffected.
const propertyTax = propertyTaxRaw as unknown as PropertyTaxTable;
const insurance = insuranceRaw as unknown as PropertyTaxTable;

const usHome = locations.find((l) => l.id === "united-states") ?? locations[0];
const METRO_KEY = "bow:metro";
const OVERRIDES_KEY = "bow:overrides";

// Manual edits we remember across reloads.
const PERSIST_FIELDS = ["homePrice", "downPaymentPct", "propertyTaxRate", "marginalTaxRate"] as const;
// Of those, the ones tied to a specific place: cleared when you pick a new metro
// (the override was for the old location). The rest are personal and always stick.
const LOCATION_FIELDS: (keyof CalcInputs)[] = ["homePrice", "propertyTaxRate"];

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

function loadOverrides(): Partial<CalcInputs> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (raw) return JSON.parse(raw) as Partial<CalcInputs>;
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

export function App() {
  const overrides = useRef<Partial<CalcInputs>>(loadOverrides());
  const [selected, setSelected] = useState<LocationData>(storedLocation);
  const [inputs, setInputs] = useState<CalcInputs>(() => ({
    ...buildInputs(storedLocation(), market, propertyTax, insurance),
    ...overrides.current, // restore the user's remembered manual edits
  }));

  const result = useMemo(() => calculate(inputs), [inputs]);

  // Manual edits from the controls. Persist the ones we remember.
  const patch = (p: Partial<CalcInputs>) => {
    setInputs((prev) => ({ ...prev, ...p }));
    let changed = false;
    for (const k of PERSIST_FIELDS) {
      if (k in p) {
        overrides.current[k] = p[k] as never;
        changed = true;
      }
    }
    if (changed) saveOverrides(overrides.current);
  };

  function selectLocation(loc: LocationData, remember = true) {
    setSelected(loc);
    // Set location-derived fields directly (not via patch) so they aren't
    // recorded as manual overrides.
    setInputs((prev) => ({
      ...prev,
      homePrice: loc.homeValue,
      monthlyRent: loc.rent,
      propertyTaxRate: propertyTax[loc.state] ?? prev.propertyTaxRate,
      homeInsuranceRate: insurance[loc.state] ?? prev.homeInsuranceRate,
    }));
    // A new place invalidates place-specific overrides (kept personal ones).
    let changed = false;
    for (const k of LOCATION_FIELDS) {
      if (k in overrides.current) {
        delete overrides.current[k];
        changed = true;
      }
    }
    if (changed) saveOverrides(overrides.current);
    if (remember) {
      try {
        localStorage.setItem(METRO_KEY, loc.id);
      } catch {
        /* storage unavailable */
      }
    }
  }

  // First visit with no saved metro: auto-detect from IP (silent fallback to US).
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    let stored = false;
    try {
      stored = !!localStorage.getItem(METRO_KEY);
    } catch {
      /* storage unavailable */
    }
    if (stored) return;
    let cancelled = false;
    detectMetro(locations).then((loc) => {
      if (!cancelled && loc) selectLocation(loc);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <Hero metro={selected.metro} result={result} inputs={inputs} />

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
          <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6 lg:sticky lg:top-6 lg:self-start">
            <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-muted">Your situation</h2>
            <Controls
              inputs={inputs}
              patch={patch}
              locations={locations}
              selected={selected}
              onSelectLocation={selectLocation}
              market={market}
            />
          </section>

          <section className="space-y-6">
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
              <CrossoverChart
                data={result.horizon}
                breakevenYear={result.breakevenYear}
                yearsToStay={inputs.yearsToStay}
              />
            </div>

            <Disclosure summary="Show the year-by-year math">
              <Breakdown years={result.years} />
            </Disclosure>
          </section>
        </div>

        <Sources />
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-paper/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-extrabold tracking-tight">buyorwhatever</span>
          <span className="hidden text-sm text-muted sm:inline">rent vs. buy, with the math shown</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          <span className="hidden sm:inline">
            data fresh as of <span className="font-semibold text-ink">{market.asOf}</span>
          </span>
          <a
            href="https://github.com/swhitt/buyorwhatever"
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
        <span className="font-semibold text-ink">{usd(result.breakevenRent)}/mo</span>. Stay longer than{" "}
        <span className="font-semibold text-ink">{monthsAndYears(result.breakevenYear)}</span> and the math flips toward
        owning.
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
          <div className={"text-xs font-bold uppercase tracking-wide " + (renting ? "text-rent" : "text-buy")}>
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
          value={monthsAndYears(result.breakevenYear)}
          sub="stay longer, buying wins"
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

function Sources() {
  const items: { label: string; value: string; href: string }[] = [
    {
      label: "Mortgage rates",
      value: `Freddie Mac PMMS · ${pct(market.mortgage.rate30, 2)} (${market.mortgage.asOf})`,
      href: "https://www.freddiemac.com/pmms",
    },
    {
      label: "Home prices & rents",
      value: `Zillow ZHVI / ZORI (${market.national.asOf})`,
      href: "https://www.zillow.com/research/data/",
    },
    {
      label: "Inflation",
      value: `BLS CPI-U · ${pct(market.inflation.rate, 1)} YoY (${market.inflation.asOf})`,
      href: "https://www.bls.gov/cpi/",
    },
    {
      label: "Property tax",
      value: "Tax Foundation, effective rates by state (2024)",
      href: "https://taxfoundation.org/data/all/state/property-taxes-by-state-county-2024/",
    },
    {
      label: "Home insurance",
      value: "Bankrate state averages / Zillow ZHVI, effective rate by state",
      href: "https://www.bankrate.com/insurance/homeowners-insurance/states/",
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
          all future cash flow at your investment-return rate. It uses a transparent four-bucket cost decomposition
          (initial costs, recurring costs, opportunity costs, and net sale proceeds), grounded in the academic
          user-cost-of-homeownership literature.
        </p>
        <p>
          Honest caveats: the SALT cap, standard deduction, and capital-gains brackets are simplified and change with
          tax law, so treat the deduction math as an estimate. Appreciation defaults to a conservative long-run figure
          rather than recent local run-ups. This is a decision aid, not financial advice.
        </p>
        <p className="pt-2">
          Free and open source. Data refreshes automatically.{" "}
          <a href="https://github.com/swhitt/buyorwhatever" className="font-semibold text-ink hover:underline">
            View the code and the model on GitHub.
          </a>
        </p>
      </div>
    </footer>
  );
}
