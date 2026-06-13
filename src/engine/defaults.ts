import type { CalcInputs } from "./calculator";
import type { LocationData, MarketData, PropertyTaxTable } from "../data/types";

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
  propertyTax: PropertyTaxTable,
  filingJointly = true,
): CalcInputs {
  return {
    homePrice: loc.homeValue,
    downPaymentPct: 0.2,
    mortgageRate: market.mortgage.rate30,
    mortgageTermYears: 30,
    homeAppreciation: 0.035,

    yearsToStay: 9,
    investmentReturn: 0.05,
    inflation: clamp(market.inflation.rate, 0.01, 0.06),

    propertyTaxRate: propertyTax[loc.state] ?? 0.011,
    maintenanceRate: 0.01,
    homeInsuranceRate: 0.005,
    hoaMonthly: 0,
    extraUtilitiesMonthly: 0,

    buyingClosingPct: 0.03,
    sellingCostPct: 0.06,
    pmiRate: 0.0058,

    marginalTaxRate: 0.24,
    standardDeduction: filingJointly ? 30000 : 15000,
    otherSALT: 0,
    saltCap: 10000,
    filingJointly,
    capitalGainsRate: 0.15,

    monthlyRent: loc.rent,
    rentGrowth: clamp(Math.max(market.inflation.rate, 0.03), 0.01, 0.06),
    rentersInsuranceMonthly: 15,
    securityDepositMonths: 1,
    brokerFeeMonths: 0,
  };
}
