import type { ReactNode } from "react";
import type { CalcInputs } from "../engine/calculator";
import type { LocationData, MarketData } from "../data/types";
import { pct, usd } from "../lib/format";
import { Disclosure, Field, LiveBadge, MoneyInput, Segmented, Slider } from "../ui";
import { LocationPicker } from "./LocationPicker";

type Patch = (p: Partial<CalcInputs>) => void;

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

export function Controls({
  inputs,
  patch,
  locations,
  selected,
  onSelectLocation,
  market,
}: {
  inputs: CalcInputs;
  patch: Patch;
  locations: LocationData[];
  selected: LocationData;
  onSelectLocation: (loc: LocationData) => void;
  market: MarketData;
}) {
  const downAmount = inputs.homePrice * inputs.downPaymentPct;
  const pmiOn = inputs.downPaymentPct < 0.2;

  return (
    <div className="space-y-5">
      <Field label="Location" hint="Sets home price, rent, and property tax from live local data.">
        <LocationPicker locations={locations} selected={selected} onSelect={onSelectLocation} />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Home price" badge={<LiveBadge>Zillow {usd(selected.homeValue)}</LiveBadge>}>
          <MoneyInput value={inputs.homePrice} onChange={(n) => patch({ homePrice: n })} />
        </Field>
        <Field label="Comparable rent" badge={<LiveBadge>Zillow {usd(selected.rent)}/mo</LiveBadge>}>
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
            {pmiOn ? <span className="text-buy">· under 20%, so PMI applies</span> : "· no PMI"}
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
              patch({ filingJointly: v === "joint", standardDeduction: v === "joint" ? 30000 : 15000 })
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
                  className="text-rent underline-offset-2 hover:underline"
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
            label="Investment return (opportunity cost)"
            value={inputs.investmentReturn}
            min={0}
            max={0.12}
            step={0.0025}
            onChange={(n) => patch({ investmentReturn: n })}
            format={(n) => pct(n, 1)}
            hint="What your down payment would earn if invested instead. The single most important assumption."
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
          <SliderRow
            label="Property tax rate"
            value={inputs.propertyTaxRate}
            min={0}
            max={0.03}
            step={0.0005}
            onChange={(n) => patch({ propertyTaxRate: n })}
            format={(n) => pct(n, 2)}
            badge={<LiveBadge>{selected.state} avg</LiveBadge>}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SliderRow
              label="Maintenance / yr"
              value={inputs.maintenanceRate}
              min={0}
              max={0.03}
              step={0.0025}
              onChange={(n) => patch({ maintenanceRate: n })}
              format={(n) => pct(n, 1)}
            />
            <SliderRow
              label="Home insurance / yr"
              value={inputs.homeInsuranceRate}
              min={0}
              max={0.02}
              step={0.0005}
              onChange={(n) => patch({ homeInsuranceRate: n })}
              format={(n) => pct(n, 2)}
            />
          </div>
          <SliderRow
            label="Marginal tax rate"
            value={inputs.marginalTaxRate}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(n) => patch({ marginalTaxRate: n })}
            format={(n) => pct(n, 0)}
            hint="Federal + state + local. Drives the value of the mortgage-interest and property-tax deductions."
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
