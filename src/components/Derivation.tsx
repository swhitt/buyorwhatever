import type { ReactNode } from "react";
import type { CalcResult } from "../engine/calculator";
import type { AppInputs } from "../engine/defaults";
import {
  FEDERAL_BRACKETS,
  STATE_TAX,
  bracketTax,
  estimateMarginalRate,
  estimateStateIncomeTax,
  type Bracket,
} from "../engine/taxRates";
import { MORTGAGE_INTEREST_DEBT_CAP } from "../engine/taxConstants";
import type { LocationData, MarketData } from "../data/types";
import { pct, usd } from "../lib/format";

// Rate like 4.4% / 22% / 2.75% with no trailing-zero noise.
const rateLabel = (r: number) => `${+(r * 100).toFixed(2)}%`;

const rangeLabel = (lo: number, hi: number | null) =>
  hi == null ? `over ${usd(lo)}` : lo === 0 ? `up to ${usd(hi)}` : `${usd(lo)} to ${usd(hi)}`;

/** A bracket schedule with the row containing `taxable` highlighted. */
function BracketTable({ brackets, taxable }: { brackets: Bracket[]; taxable: number }) {
  const activeIdx = brackets.findIndex((b) => b.upTo == null || taxable <= b.upTo);
  let lo = 0;
  const rows = brackets.map((b) => {
    const row = { rate: b.rate, lo, hi: b.upTo };
    lo = b.upTo ?? lo;
    return row;
  });
  return (
    <table className="tnum mt-1 w-full max-w-sm text-left">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={i === activeIdx ? "font-bold text-ink" : "text-muted"}>
            <td className="w-16 py-0.5 pr-4">{rateLabel(r.rate)}</td>
            <td className="py-0.5">
              {rangeLabel(r.lo, r.hi)}
              {i === activeIdx ? "  ← you" : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Row({ label, value, source }: { label: string; value: string; source: string }) {
  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="whitespace-nowrap py-1.5 pr-4 text-muted">{label}</td>
      <td className="tnum whitespace-nowrap py-1.5 pr-4 font-semibold text-ink">{value}</td>
      <td className="py-1.5 text-muted">{source}</td>
    </tr>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{title}</h4>
      {children}
    </div>
  );
}

/**
 * "Show your work" for every input we derive rather than ask for: the tax brackets
 * actually applied (federal + state, your row highlighted), how the deduction is
 * valued, whether you itemize, and which live dataset each headline number came from.
 */
export function Derivation({
  inputs,
  result,
  market,
  selected,
}: {
  inputs: AppInputs;
  result: CalcResult;
  market: MarketData;
  selected: LocationData;
}) {
  const status = inputs.filingJointly ? "joint" : "single";
  const taxable = Math.max(0, inputs.annualIncome - inputs.standardDeduction);
  const est = estimateMarginalRate(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
  const stateTaxDollars = estimateStateIncomeTax(
    inputs.annualIncome,
    inputs.filingJointly,
    inputs.taxState,
    inputs.localTaxRate,
  );
  const st = STATE_TAX[inputs.taxState];
  const stateName = st?.name;
  const stateNone = !!st && st[status].length === 1 && st[status][0].rate === 0;
  const stateFlat = !!st && st[status].length === 1 && st[status][0].rate > 0;
  const autoLive = inputs.taxAuto && inputs.annualIncome > 0;

  // Year-1 deduction picture, straight off the engine's first row.
  const y1 = result.years[0];
  const loan = inputs.homePrice * (1 - inputs.downPaymentPct);
  const intFrac = loan > 0 ? Math.min(1, MORTGAGE_INTEREST_DEBT_CAP / loan) : 1;
  const saltDollars = autoLive ? stateTaxDollars : inputs.otherSALT;
  const saltUsed = Math.min((y1?.propertyTax ?? 0) + saltDollars, inputs.saltCap);
  const itemized = (y1?.interestPaid ?? 0) * intFrac + saltUsed;
  const itemizes = (y1?.taxBenefit ?? 0) > 0;

  // Actual tax owed, summed across the full bracket schedule (not marginal * income).
  const fedTax = Math.round(bracketTax(FEDERAL_BRACKETS[status], taxable));
  const stateScheduleTax = st ? Math.round(bracketTax(st[status], taxable)) : 0;
  const localTax = Math.round(est.local * taxable);
  const fedEff = inputs.annualIncome > 0 ? fedTax / inputs.annualIncome : 0;
  const stateEff = inputs.annualIncome > 0 ? stateScheduleTax / inputs.annualIncome : 0;

  return (
    <div className="space-y-6 text-sm">
      <Section title="Income tax derivation">
        {autoLive ? (
          <div className="space-y-3">
            <p className="text-muted">
              {inputs.filingJointly ? "Married/joint" : "Single"}, income{" "}
              <span className="font-semibold text-ink">{usd(inputs.annualIncome)}</span> gives taxable income of about{" "}
              <span className="font-semibold text-ink">{usd(taxable)}</span> (income minus the{" "}
              {usd(inputs.standardDeduction)} standard deduction). State income tax is estimated on the same base.
            </p>

            <div>
              <p className="font-medium text-ink">
                Federal 2026: marginal {rateLabel(est.federal)}, which is what values the deduction
              </p>
              <BracketTable brackets={FEDERAL_BRACKETS[status]} taxable={taxable} />
              <p className="mt-1 text-muted">
                Full schedule on {usd(taxable)} taxable: <span className="tnum text-ink">{usd(fedTax)}</span> federal
                income tax ({pct(fedEff, 1)} of income).
              </p>
            </div>

            <div>
              {stateNone ? (
                <p className="font-medium text-ink">{stateName}: no state income tax</p>
              ) : stateFlat ? (
                <p className="font-medium text-ink">
                  {stateName}: flat {rateLabel(est.state)}, so{" "}
                  <span className="tnum">{usd(stateScheduleTax)}</span> state income tax ({pct(stateEff, 1)} of income),
                  which counts toward your SALT cap.
                </p>
              ) : st ? (
                <>
                  <p className="font-medium text-ink">{stateName}: marginal {rateLabel(est.state)}</p>
                  <BracketTable brackets={st[status]} taxable={taxable} />
                  <p className="mt-1 text-muted">
                    Full schedule: <span className="tnum text-ink">{usd(stateScheduleTax)}</span> state income tax (
                    {pct(stateEff, 1)} of income)
                    {localTax > 0 ? ` plus ${usd(localTax)} local` : ""}, all counting toward your SALT cap.
                  </p>
                </>
              ) : (
                <p className="font-medium text-ink">No state income tax applied (national)</p>
              )}
              {est.local > 0 && stateFlat && (
                <p className="mt-1 text-muted">Plus {usd(localTax)} local income tax, also part of SALT.</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-muted">
            Marginal rate set manually to <span className="font-semibold text-ink">{pct(inputs.marginalTaxRate, 0)}</span>
            . Switch the Income tax rate control to <span className="font-semibold text-ink">From income</span> to derive
            it from 2026 federal and state brackets.
          </p>
        )}

        <div className="mt-3 rounded-lg border border-line bg-paper px-3 py-2">
          <p className="text-muted">
            Mortgage-interest cap {usd(MORTGAGE_INTEREST_DEBT_CAP)} of acquisition debt: your loan{" "}
            <span className="tnum text-ink">{usd(loan)}</span> means{" "}
            <span className="tnum text-ink">{rateLabel(intFrac)}</span> of year-1 interest is deductible
            {intFrac < 1 ? " (rising to 100% as it amortizes under the cap)" : ""}.
          </p>
          <p className="mt-1 text-muted">
            Year-1 itemized of about <span className="tnum text-ink">{usd(itemized)}</span> vs the{" "}
            <span className="tnum text-ink">{usd(inputs.standardDeduction)}</span> standard deduction:{" "}
            {itemizes ? (
              <span className="font-semibold text-buy-text">
                you itemize, so buying earns about {usd(y1?.taxBenefit ?? 0)} of federal tax benefit in year 1 (it
                tapers as the loan amortizes and interest falls; see the year-by-year table).
              </span>
            ) : (
              <span className="font-semibold text-ink">
                the standard deduction wins, so buying gives no federal tax benefit at these numbers.
              </span>
            )}
          </p>
        </div>
      </Section>

      <Section title="Inputs from live data">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse">
            <tbody>
              <Row
                label="Home price"
                value={usd(inputs.homePrice)}
                source={`Zillow ZHVI · ${selected.metro} · ${market.national.asOf}`}
              />
              <Row
                label="Comparable rent"
                value={`${usd(inputs.monthlyRent)}/mo`}
                source={`Zillow ZORI · ${selected.metro} · ${market.national.asOf}`}
              />
              <Row
                label={`Mortgage rate (${inputs.mortgageTermYears}yr)`}
                value={pct(inputs.mortgageRate, 2)}
                source={`Freddie Mac PMMS · ${market.mortgage.asOf}`}
              />
              <Row label="Inflation" value={pct(inputs.inflation, 1)} source={`BLS CPI-U · ${market.inflation.asOf}`} />
              <Row
                label="Property tax"
                value={
                  inputs.propertyTaxMode === "amount"
                    ? `${usd(inputs.propertyTaxAnnual)}/yr`
                    : `${pct(inputs.propertyTaxRate, 2)} of value`
                }
                source={`${selected.state} avg · WalletHub / Census ACS 2024`}
              />
              <Row
                label="Home insurance"
                value={
                  inputs.homeInsuranceMode === "amount"
                    ? `${usd(inputs.homeInsuranceAnnual)}/yr`
                    : `${pct(inputs.homeInsuranceRate, 2)} of value`
                }
                source={`${selected.state} avg · NAIC HO-3 / Zillow ZHVI`}
              />
              <Row
                label="Appreciation"
                value={pct(inputs.homeAppreciation, 1)}
                source={
                  selected.appreciation5yr != null
                    ? `Long-run default · ${selected.metro} ran ${pct(selected.appreciation5yr, 1)}/yr last 5yr`
                    : "Long-run default (conservative)"
                }
              />
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
