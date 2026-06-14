import type { ReactNode } from "react";
import type { CostBasis } from "../engine/calculator";
import type { AppInputs } from "../engine/defaults";
import { STANDARD_DEDUCTION } from "../engine/taxConstants";
import { estimateMarginalRate, STATE_OPTIONS, STATE_TAX } from "../engine/taxRates";
import type { LocationData, MarketData } from "../data/types";
import { pct, usd } from "../lib/format";
import type { ZipData } from "../lib/zips";
import { Disclosure, Field, LiveBadge, MoneyInput, Segmented, Slider } from "../ui";
import { LocationPicker, type ActiveZip } from "./LocationPicker";

type Patch = (p: Partial<AppInputs>) => void;

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  badge,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  format: (n: number) => string;
  badge?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Field label={label} badge={badge} hint={hint}>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} format={format} />
    </Field>
  );
}

/**
 * A recurring cost the user can express either as a percent of home value (a
 * slider, which rides the appreciating value) or as a flat dollar figure (a
 * money input, which rides inflation). The hint shows the equivalent the other
 * way so switching modes is never a surprise.
 */
function CostRow({
  label,
  basis,
  onChange,
  rateMax,
  rateStep,
  rateDigits,
  annualStep,
  homePrice,
  badge,
}: {
  label: string;
  basis: CostBasis;
  onChange: (b: CostBasis) => void;
  rateMax: number;
  rateStep: number;
  rateDigits: number;
  annualStep: number;
  homePrice: number;
  badge?: ReactNode;
}) {
  const mode = basis.kind === "pctOfValue" ? "pct" : "amount";
  // Derive the other representation so the hint and a %/$ toggle have a seed and the
  // displayed figure never jumps across a mode switch.
  const rate = basis.kind === "pctOfValue" ? basis.rate : homePrice > 0 ? basis.annual / homePrice : 0;
  const annual = basis.kind === "flatAnnual" ? basis.annual : Math.round(homePrice * basis.rate);
  const setMode = (m: "pct" | "amount") => {
    if (m === mode) return;
    onChange(m === "pct" ? { kind: "pctOfValue", rate } : { kind: "flatAnnual", annual });
  };
  const header = (
    <span className="flex items-center gap-2">
      {/* Keep the live benchmark badge in both modes; it's the reference you check a
          typed dollar figure against. */}
      {badge}
      <Segmented
        value={mode}
        onChange={(v) => setMode(v as "pct" | "amount")}
        options={[
          { label: "%", value: "pct" },
          { label: "$", value: "amount" },
        ]}
      />
    </span>
  );
  const hint =
    mode === "pct"
      ? `${usd(homePrice * rate)}/yr now, rising with the home's value`
      : homePrice > 0
        ? `${pct(annual / homePrice, 2)} of today's value, rising with inflation`
        : undefined;
  return (
    <Field label={label} badge={header} hint={hint}>
      {mode === "pct" ? (
        <Slider
          value={rate}
          min={0}
          max={rateMax}
          step={rateStep}
          onChange={(n) => onChange({ kind: "pctOfValue", rate: n })}
          format={(n) => pct(n, rateDigits)}
        />
      ) : (
        <MoneyInput value={annual} onChange={(n) => onChange({ kind: "flatAnnual", annual: n })} step={annualStep} />
      )}
    </Field>
  );
}

/** Native state picker, styled to match the money/text inputs. */
function StateSelect({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <select
      aria-label="State"
      value={STATE_TAX[value] ? value : "US"}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] font-medium outline-none focus:border-ink focus:ring-2 focus:ring-ink/10"
    >
      <option value="US">National (no state tax)</option>
      <optgroup label="State">
        {STATE_OPTIONS.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/**
 * Marginal income tax rate, either estimated from income + filing + state (so a
 * user who doesn't know their bracket can still see the deduction's impact) or set
 * by hand. The mortgage-interest and property-tax deductions are federal, so the
 * engine values them at the federal rate; the state/local rate is shown for context
 * and its income tax feeds the SALT base. A labelled group, not a <label>, since it
 * holds several controls.
 */
function TaxRateControl({ inputs, patch }: { inputs: AppInputs; patch: Patch }) {
  const auto = inputs.taxAuto;
  const hasIncome = inputs.annualIncome > 0;
  const est = estimateMarginalRate(inputs.annualIncome, inputs.filingJointly, inputs.taxState, inputs.localTaxRate);
  const stateLabel = STATE_TAX[inputs.taxState]?.name ? inputs.taxState : null;

  return (
    <Field
      label="Income tax rate"
      group
      badge={
        <Segmented
          value={auto ? "auto" : "manual"}
          onChange={(v) => patch({ taxAuto: v === "auto" })}
          options={[
            { label: "From income", value: "auto" },
            { label: "Manual", value: "manual" },
          ]}
        />
      }
      hint={
        auto
          ? "The federal rate values the mortgage-interest and property-tax deduction; your state and local income tax add to the SALT cap."
          : "Your federal marginal rate, which values the mortgage-interest and property-tax deduction."
      }
    >
      {auto ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Household income (gross)</span>
              <MoneyInput value={inputs.annualIncome} onChange={(n) => patch({ annualIncome: n })} step={5000} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">State</span>
              <StateSelect value={inputs.taxState} onChange={(s) => patch({ taxState: s })} />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Local income tax</span>
            <Slider
              value={inputs.localTaxRate}
              min={0}
              max={0.05}
              step={0.00125}
              onChange={(n) => patch({ localTaxRate: n })}
              format={(n) => pct(n, 2)}
            />
            <span className="mt-1 block text-xs text-muted">
              City/county, on top of state. e.g. NYC ≈ 3.9%, Yonkers, some OH/PA municipalities. Leave at 0 if none.
            </span>
          </label>
          {hasIncome ? (
            <div className="rounded-lg border border-line bg-paper px-3 py-2 text-sm">
              <span className="tnum font-bold text-ink">{pct(est.federal, 1)}</span>{" "}
              <span className="text-muted">
                federal rate values the deduction · {pct(est.combined, 1)} combined marginal (fed {pct(est.federal, 1)}
                {est.state > 0 && stateLabel ? ` + ${stateLabel} ${pct(est.state, 1)}` : ""}
                {est.local > 0 ? ` + local ${pct(est.local, 1)}` : ""})
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted">
              Enter your income to estimate a rate. Until then, {pct(inputs.marginalTaxRate, 0)} is used.
            </p>
          )}
        </div>
      ) : (
        <Slider
          value={inputs.marginalTaxRate}
          min={0}
          max={0.5}
          step={0.01}
          onChange={(n) => patch({ marginalTaxRate: n })}
          format={(n) => pct(n, 0)}
        />
      )}
    </Field>
  );
}

export function Controls({
  inputs,
  patch,
  locations,
  selected,
  activeZip,
  onSelectLocation,
  onSelectZip,
  market,
}: {
  inputs: AppInputs;
  patch: Patch;
  locations: LocationData[];
  selected: LocationData;
  activeZip: ActiveZip | null;
  onSelectLocation: (loc: LocationData) => void;
  onSelectZip: (zip: string, data: ZipData) => void;
  market: MarketData;
}) {
  const downAmount = inputs.homePrice * inputs.downPaymentPct;
  const pmiOn = inputs.downPaymentPct < 0.2;

  return (
    <div className="space-y-5">
      <Field label="Location" hint="Search a metro or type a ZIP for that ZIP's own home price and rent.">
        <LocationPicker
          locations={locations}
          selected={selected}
          activeZip={activeZip}
          onSelect={onSelectLocation}
          onSelectZip={onSelectZip}
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Home price" badge={<LiveBadge>Zillow {usd(activeZip ? activeZip.homeValue : selected.homeValue)}</LiveBadge>}>
          <MoneyInput value={inputs.homePrice} onChange={(n) => patch({ homePrice: n })} />
        </Field>
        <Field label="Comparable rent" badge={<LiveBadge>Zillow {usd(activeZip ? activeZip.rent : selected.rent)}/mo</LiveBadge>}>
          <MoneyInput value={inputs.monthlyRent} onChange={(n) => patch({ monthlyRent: n })} step={50} />
        </Field>
      </div>

      <SliderRow
        label="Down payment"
        value={inputs.downPaymentPct}
        min={0}
        max={0.5}
        step={0.01}
        onChange={(n) => patch({ downPaymentPct: n })}
        format={(n) => pct(n, 0)}
        hint={
          <span>
            {usd(downAmount)} down{" "}
            {pmiOn ? <span className="text-buy-text">· under 20%, so PMI applies</span> : "· no PMI"}
          </span>
        }
      />

      <SliderRow
        label="How long you'll stay"
        value={inputs.yearsToStay}
        min={1}
        max={30}
        step={1}
        onChange={(n) => patch({ yearsToStay: n })}
        format={(n) => `${n}y`}
      />

      <SliderRow
        label="Investment return"
        value={inputs.investmentReturn}
        min={0}
        max={0.12}
        step={0.0025}
        onChange={(n) => patch({ investmentReturn: n })}
        format={(n) => pct(n, 1)}
        hint={(() => {
          const dp = inputs.homePrice * inputs.downPaymentPct;
          const fv = dp * Math.pow(1 + inputs.investmentReturn, inputs.yearsToStay);
          return `Your ${usd(dp)} down payment, invested instead, would grow to about ${usd(fv)} in ${inputs.yearsToStay} years, money buying has to beat. The single biggest lever: higher favors renting.`;
        })()}
      />

      <SliderRow
        label="Mortgage rate"
        value={inputs.mortgageRate}
        min={0.02}
        max={0.12}
        step={0.00125}
        onChange={(n) => patch({ mortgageRate: n })}
        format={(n) => pct(n, 2)}
        badge={<LiveBadge>Freddie Mac {pct(market.mortgage.rate30, 2)}</LiveBadge>}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Field label="Tax filing">
          <Segmented
            value={inputs.filingJointly ? "joint" : "single"}
            onChange={(v) =>
              patch({
                filingJointly: v === "joint",
                standardDeduction: v === "joint" ? STANDARD_DEDUCTION.joint : STANDARD_DEDUCTION.single,
              })
            }
            options={[
              { label: "Married/joint", value: "joint" },
              { label: "Single", value: "single" },
            ]}
          />
        </Field>
        <Field label="Mortgage term">
          <Segmented
            value={inputs.mortgageTermYears}
            onChange={(v) => patch({ mortgageTermYears: v, mortgageRate: v === 15 ? market.mortgage.rate15 : market.mortgage.rate30 })}
            options={[
              { label: "30 yr", value: 30 },
              { label: "15 yr", value: 15 },
            ]}
          />
        </Field>
      </div>

      <Disclosure summary="Advanced assumptions">
        <div className="space-y-5">
          <SliderRow
            label="Home appreciation"
            value={inputs.homeAppreciation}
            min={0}
            max={0.08}
            step={0.0025}
            onChange={(n) => patch({ homeAppreciation: n })}
            format={(n) => pct(n, 1)}
            hint={
              selected.appreciation5yr != null ? (
                <button
                  type="button"
                  className="text-rent-text underline-offset-2 hover:underline"
                  onClick={() => patch({ homeAppreciation: selected.appreciation5yr! })}
                >
                  {selected.metro} ran {pct(selected.appreciation5yr, 1)}/yr the last 5 years (use it)
                </button>
              ) : (
                "Long-run default. Recent local run-ups overstate the future."
              )
            }
          />
          <SliderRow
            label="Rent growth"
            value={inputs.rentGrowth}
            min={0}
            max={0.08}
            step={0.0025}
            onChange={(n) => patch({ rentGrowth: n })}
            format={(n) => pct(n, 1)}
          />
          <SliderRow
            label="Inflation"
            value={inputs.inflation}
            min={0}
            max={0.08}
            step={0.0025}
            onChange={(n) => patch({ inflation: n })}
            format={(n) => pct(n, 1)}
            badge={<LiveBadge>BLS CPI {pct(market.inflation.rate, 1)}</LiveBadge>}
          />
          <CostRow
            label="Property tax"
            basis={inputs.propertyTax}
            onChange={(b) => patch({ propertyTax: b })}
            rateMax={0.03}
            rateStep={0.0005}
            rateDigits={2}
            annualStep={250}
            homePrice={inputs.homePrice}
            badge={<LiveBadge>{selected.state} avg</LiveBadge>}
          />
          <CostRow
            label="Maintenance / yr"
            basis={inputs.maintenance}
            onChange={(b) => patch({ maintenance: b })}
            rateMax={0.03}
            rateStep={0.0025}
            rateDigits={1}
            annualStep={250}
            homePrice={inputs.homePrice}
          />
          <CostRow
            label="Home insurance / yr"
            basis={inputs.homeInsurance}
            onChange={(b) => patch({ homeInsurance: b })}
            rateMax={0.03}
            rateStep={0.0005}
            rateDigits={2}
            annualStep={100}
            homePrice={inputs.homePrice}
            badge={<LiveBadge>{selected.state} avg</LiveBadge>}
          />
          <TaxRateControl inputs={inputs} patch={patch} />
          <SliderRow
            label="Buying closing costs"
            value={inputs.buyingClosingPct}
            min={0}
            max={0.06}
            step={0.0025}
            onChange={(n) => patch({ buyingClosingPct: n })}
            format={(n) => pct(n, 1)}
          />
          <SliderRow
            label="Selling costs"
            value={inputs.sellingCostPct}
            min={0}
            max={0.1}
            step={0.0025}
            onChange={(n) => patch({ sellingCostPct: n })}
            format={(n) => pct(n, 1)}
          />
          {/* These labels are long; the controls column narrows to 380px at lg, so
              stack them there to avoid the labels colliding (2-up in roomier widths). */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <Field label="HOA / common (monthly)">
              <MoneyInput value={inputs.hoaMonthly} onChange={(n) => patch({ hoaMonthly: n })} step={25} />
            </Field>
            <Field label="Renter's insurance (monthly)">
              <MoneyInput
                value={inputs.rentersInsuranceMonthly}
                onChange={(n) => patch({ rentersInsuranceMonthly: n })}
                step={5}
              />
            </Field>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
