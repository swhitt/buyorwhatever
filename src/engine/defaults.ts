import type { CalcInputs } from "./calculator";
import { SALT_CAP, STANDARD_DEDUCTION } from "./taxConstants";
import type { LocationData, MarketData, StateRateTable } from "../data/types";

/**
 * UI-only tax-estimator state. The engine never reads these: the controls project
 * them into `marginalTaxRate` + `otherSALT` before calling `calculate`, so they're
 * kept out of the pure engine contract (`CalcInputs`) and bolted on here instead.
 */
export interface TaxEstimatorState {
  taxAuto: boolean; // estimate the marginal rate from income/state instead of typing it
  annualIncome: number; // household gross income, for the marginal-rate estimate
  taxState: string; // 2-letter state code ("US" = no state income tax applied)
  localTaxRate: number; // optional city/county income tax added onto the estimate
}

/** Everything the app holds in its input state: the engine contract plus UI state. */
export type AppInputs = CalcInputs & TaxEstimatorState;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Build a starting set of inputs from live market data and a chosen location.
 *
 * Note on appreciation: we default to a conservative long-run assumption rather
 * than a metro's recent 5yr CAGR. Recent run-ups overstate forward returns, and
 * an honest calculator shouldn't quietly tilt the answer toward buying. The live
 * local figure is surfaced in the UI as context, not baked into the default.
 */
export function buildInputs(
  loc: LocationData,
  market: MarketData,
  propertyTax: StateRateTable,
  insurance: StateRateTable,
  filingJointly = true,
): AppInputs {
  return {
    homePrice: loc.homeValue,
    downPaymentPct: 0.2,
    mortgageRate: market.mortgage.rate30,
    mortgageTermYears: 30,
    homeAppreciation: 0.035,

    yearsToStay: 9,
    // Long-run nominal for a balanced/equity portfolio (the opportunity cost of the
    // down payment). The single most important assumption; higher favors renting.
    investmentReturn: 0.06,
    inflation: clamp(market.inflation.rate, 0.01, 0.06),

    propertyTaxMode: "pct",
    propertyTaxRate: propertyTax[loc.state] ?? 0.011,
    propertyTaxAnnual: Math.round(loc.homeValue * (propertyTax[loc.state] ?? 0.011)),
    maintenanceMode: "pct",
    maintenanceRate: 0.01,
    // Dollar defaults track the percent defaults at today's value, so toggling
    // %/$ starts from the same number instead of jumping.
    maintenanceAnnual: Math.round(loc.homeValue * 0.01),
    homeInsuranceMode: "pct",
    homeInsuranceRate: insurance[loc.state] ?? 0.005,
    homeInsuranceAnnual: Math.round(loc.homeValue * (insurance[loc.state] ?? 0.005)),
    hoaMonthly: 0,
    extraUtilitiesMonthly: 0,

    buyingClosingPct: 0.03,
    sellingCostPct: 0.06,
    pmiRate: 0.0058,

    marginalTaxRate: 0.24,
    standardDeduction: filingJointly ? STANDARD_DEDUCTION.joint : STANDARD_DEDUCTION.single,
    otherSALT: 0,
    saltCap: SALT_CAP,
    filingJointly,
    capitalGainsRate: 0.15,
    // Tax-rate estimator is on by default (it's the headline feature) but falls back
    // to the manual 24% until an income is entered; state is pre-seeded from location.
    taxAuto: true,
    annualIncome: 0,
    taxState: loc.state,
    localTaxRate: 0,

    monthlyRent: loc.rent,
    rentGrowth: clamp(Math.max(market.inflation.rate, 0.03), 0.01, 0.06),
    rentersInsuranceMonthly: 15,
    securityDepositMonths: 1,
    brokerFeeMonths: 0,
  };
}
