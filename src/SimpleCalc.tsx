import { lazy, Suspense, useMemo, useState } from "react";
import { calculate } from "./engine/calculator";
import { buildInputs, type AppInputs } from "./engine/defaults";
import { usd } from "./lib/format";
import { ThemeToggle } from "./theme";
import { Field, MoneyInput, Slider } from "./ui";
import { insurance, market, propertyTax, usHome } from "./data/rates";

// The simple mode reuses the full engine and one chart; everything else (taxes,
// appreciation, opportunity cost) rides the same defaults the full calculator seeds.
const AdvantageChart = lazy(() =>
  import("./components/AdvantageChart").then((m) => ({ default: m.AdvantageChart })),
);

export function SimpleCalc() {
  const [inputs, setInputs] = useState<AppInputs>(() => buildInputs(usHome, market, propertyTax, insurance));
  const patch = (p: Partial<AppInputs>) => setInputs((prev) => ({ ...prev, ...p }));
  const result = useMemo(() => calculate(inputs), [inputs]);

  const renting = result.verdict === "rent";
  const closeCall = Math.abs(result.monthlyDifference) < inputs.monthlyRent * 0.05;
  const verdict = closeCall ? "It's a toss-up" : renting ? "Rent" : "Buy";
  const accent = closeCall ? "text-ink" : renting ? "text-rent" : "text-buy";
  const aheadAmount = Math.abs(result.rentNetCost - result.buyNetCost);
  const years = inputs.yearsToStay;
  const crossYear = result.breakevenYear == null ? null : new Date().getFullYear() + result.breakevenYear;

  return (
    <div className="min-h-screen overflow-x-clip">
      <header className="sticky top-0 z-20 border-b border-line/70 bg-paper/80 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <a href="/" className="flex items-baseline gap-2">
            <span className="text-lg font-extrabold tracking-tight">
              <span className="text-rent">break</span>
              <span className="text-buy">Even</span>
            </span>
            <span className="hidden text-sm text-muted sm:inline">the quick answer</span>
          </a>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 pb-24 pt-8 sm:pt-12">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Should you rent or buy?</h1>
        <p className="mt-2 text-muted">Four numbers, one answer. Sensible defaults for everything else.</p>

        <div className="mt-6 grid grid-cols-1 gap-x-6 gap-y-5 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:grid-cols-2 sm:p-6">
          <Field label="Home price">
            <MoneyInput value={inputs.homePrice} onChange={(n) => patch({ homePrice: n })} step={5000} />
          </Field>
          <Field label="Comparable rent / mo">
            <MoneyInput value={inputs.monthlyRent} onChange={(n) => patch({ monthlyRent: n })} step={50} />
          </Field>
          <Field label="Down payment">
            <Slider
              value={inputs.downPaymentPct}
              min={0}
              max={0.5}
              step={0.01}
              onChange={(n) => patch({ downPaymentPct: n })}
              format={(n) => `${Math.round(n * 100)}%`}
            />
          </Field>
          <Field label="How long you'll stay">
            <Slider
              value={years}
              min={1}
              max={30}
              step={1}
              onChange={(n) => patch({ yearsToStay: n })}
              format={(n) => `${n}y`}
            />
          </Field>
        </div>

        <div
          className={
            "mt-6 rounded-2xl border p-6 shadow-sm sm:p-8 " +
            (closeCall ? "border-line bg-surface" : renting ? "border-rent/30 bg-rent-soft/40" : "border-buy/30 bg-buy-soft/40")
          }
        >
          <div className={"text-4xl font-extrabold tracking-tight sm:text-5xl " + accent}>{verdict}</div>
          <p className="mt-3 text-lg text-ink">
            {closeCall ? (
              <>
                Over {years} {years === 1 ? "year" : "years"} it's basically a wash, the two come within{" "}
                <span className="font-bold">{usd(aheadAmount)}</span>. Decide on what the math can't measure.
              </>
            ) : (
              <>
                Over your {years} {years === 1 ? "year" : "years"}, {renting ? "renting" : "buying"} leaves you about{" "}
                <span className="font-bold">{usd(aheadAmount)}</span> better off.
              </>
            )}
          </p>
          <p className="mt-2 text-muted">
            {result.breakevenYear == null
              ? "Buying never catches up, even after 30 years at this rent."
              : renting
                ? `Buying only pulls ahead if you stay past about ${result.breakevenYear} years (around ${crossYear}).`
                : `It pulls ahead around ${crossYear}, and the lead grows the longer you stay.`}
          </p>
        </div>

        <div className="mt-6 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-bold">How far ahead each option is</h2>
            <span className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-buy" /> Buying
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-sm bg-rent" /> Renting
              </span>
            </span>
          </div>
          <Suspense fallback={<div className="h-72 w-full sm:h-80" />}>
            <AdvantageChart data={result.horizon} breakevenYear={result.breakevenYear} yearsToStay={years} />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          Want taxes, the year-by-year breakdown, and every assumption?{" "}
          <a href="/" className="font-semibold text-ink underline-offset-2 hover:underline">
            Open the full calculator
          </a>
        </p>
      </main>
    </div>
  );
}
