/**
 * Rent-vs-buy engine.
 *
 * Model uses a four-bucket cost decomposition (initial costs, recurring costs,
 * opportunity costs, net sale proceeds), grounded in the user-cost-of-
 * homeownership literature (Himmelberg, Mayer & Sinai 2005). Every cash flow is
 * discounted at the investment-return rate,
 * which IS the opportunity cost of capital, then we solve for the monthly rent
 * at which buying and renting break even.
 *
 * Two headline outputs:
 *   1. breakevenRent  - the first-year monthly rent that makes buying == renting
 *                       at the chosen horizon. Rent for less => renting wins.
 *   2. breakevenYear  - the horizon at which buying overtakes renting given the
 *                       rent the user actually entered ("stay longer than N years
 *                       and buying wins").
 *
 * The simulation is monthly for accuracy (amortization, PMI drop-off, compounding).
 */

import { MORTGAGE_INTEREST_DEBT_CAP } from "./taxConstants";

export interface CalcInputs {
  // Purchase
  homePrice: number;
  downPaymentPct: number; // fraction, e.g. 0.2
  mortgageRate: number; // annual, e.g. 0.0652
  mortgageTermYears: number; // e.g. 30
  homeAppreciation: number; // annual, e.g. 0.03

  // Horizon & money
  yearsToStay: number; // e.g. 9
  investmentReturn: number; // annual opportunity / discount rate, e.g. 0.05
  inflation: number; // annual, e.g. 0.024

  // Recurring ownership costs.
  // Property tax, maintenance, and insurance can each be entered two ways (`*Mode`):
  //   "pct"    - a fraction of the *current* (appreciating) home value / yr.
  //   "amount" - a flat dollar figure / yr in today's dollars, grown with inflation
  //              (useful where assessment caps decouple the bill from market value).
  // The engine reads `*Rate` in pct mode and `*Annual` in amount mode.
  propertyTaxMode: "pct" | "amount";
  propertyTaxRate: number; // of current home value / yr, e.g. 0.011
  propertyTaxAnnual: number; // $/yr in today's dollars, e.g. 4000
  maintenanceMode: "pct" | "amount";
  maintenanceRate: number; // of current home value / yr, e.g. 0.01
  maintenanceAnnual: number; // $/yr in today's dollars, e.g. 4000
  homeInsuranceMode: "pct" | "amount";
  homeInsuranceRate: number; // of current home value / yr, e.g. 0.005
  homeInsuranceAnnual: number; // $/yr in today's dollars, e.g. 1800
  hoaMonthly: number; // grows with inflation
  extraUtilitiesMonthly: number; // owning vs renting delta, grows with inflation

  // Transaction costs
  buyingClosingPct: number; // of price, e.g. 0.03
  sellingCostPct: number; // of sale price, e.g. 0.06

  // Financing extras
  pmiRate: number; // of original loan / yr while LTV > 80%, e.g. 0.0058

  // Taxes
  marginalTaxRate: number; // e.g. 0.24
  standardDeduction: number; // for the itemization-premium calc
  otherSALT: number; // other state/local taxes counted toward SALT cap
  saltCap: number; // e.g. 10000
  filingJointly: boolean; // cap-gains exclusion 500k vs 250k
  capitalGainsRate: number; // e.g. 0.15

  // Rent side
  monthlyRent: number; // market rent being compared
  rentGrowth: number; // annual, e.g. 0.03
  rentersInsuranceMonthly: number;
  securityDepositMonths: number; // e.g. 1
  brokerFeeMonths: number; // e.g. 0
}

export interface YearRow {
  year: number;
  // buy
  mortgagePaid: number;
  interestPaid: number;
  principalPaid: number;
  propertyTax: number;
  maintenance: number;
  insurance: number;
  hoa: number;
  pmi: number;
  taxBenefit: number; // positive = money back (itemization premium over the standard deduction)
  homeValue: number;
  loanBalance: number;
  equity: number;
  // rent
  rentPaid: number;
}

export interface HorizonPoint {
  year: number;
  buyNetCost: number; // PV today's dollars
  rentNetCost: number; // PV today's dollars
}

export interface CalcResult {
  breakevenRent: number; // first-year monthly rent that ties buy vs rent at yearsToStay
  verdict: "buy" | "rent";
  monthlyDifference: number; // breakevenRent - monthlyRent (positive => renting cheaper)
  buyNetCost: number; // PV at yearsToStay
  rentNetCost: number; // PV at yearsToStay
  breakevenYear: number | null; // horizon where buying overtakes renting at entered rent
  monthlyPayment: number; // mortgage P&I
  loanAmount: number;
  horizon: HorizonPoint[]; // per-year net cost, both sides, for charting
  years: YearRow[]; // per-year breakdown for the "show your work" table
}

const clampPos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Clamp inputs to safe ranges before simulating. The sliders already keep normal
 * use in range, so this is a no-op for the UI; its job is to stop a crafted ?s=
 * share link or a momentarily-empty field from driving the sim to NaN/Infinity
 * (negative-base fractional powers, a negative discount factor) and then having
 * clampPos launder that into a confident, wrong "buy" verdict.
 */
export function sanitizeInputs(inp: CalcInputs): CalcInputs {
  return {
    ...inp,
    homePrice: Math.max(0, inp.homePrice),
    // Growth rates feed Math.pow(1 + r, t) with fractional t, so 1 + r must stay >= 0.
    homeAppreciation: Math.max(-1, inp.homeAppreciation),
    inflation: Math.max(-1, inp.inflation),
    rentGrowth: Math.max(-1, inp.rentGrowth),
    mortgageRate: Math.max(0, inp.mortgageRate),
    // Discount rate is an opportunity cost: negative would inflate future flows.
    investmentReturn: Math.max(0, inp.investmentReturn),
    downPaymentPct: Math.min(1, Math.max(0, inp.downPaymentPct)),
    // Term 0 would skip amortization yet still net out the full balance at sale
    // (an interest-free balloon); a financed purchase needs at least one year.
    mortgageTermYears: Math.max(1, inp.mortgageTermYears),
    yearsToStay: Math.max(1, inp.yearsToStay),
  };
}

/** Standard fixed-rate monthly payment. */
export function monthlyMortgagePayment(loan: number, annualRate: number, termYears: number): number {
  const n = Math.round(termYears * 12);
  if (n <= 0) return 0;
  const i = annualRate / 12;
  if (i === 0) return loan / n;
  const f = Math.pow(1 + i, n);
  return (loan * i * f) / (f - 1);
}

interface BuySim {
  pvCost: number;
  years: YearRow[];
  monthlyPayment: number;
  loanAmount: number;
}

/**
 * Present-value cost of buying, assuming a sale at `horizonYears`.
 * Positive = net dollars spent in today's money. Monthly cash flows discounted
 * at investmentReturn/12. Tax benefit credited annually as the itemization
 * premium over the standard deduction (so it's $0 when standard deduction wins).
 */
function simulateBuy(inp: CalcInputs, horizonYears: number, collectRows: boolean): BuySim {
  const months = Math.round(horizonYears * 12);
  const loan = inp.homePrice * (1 - inp.downPaymentPct);
  const payment = monthlyMortgagePayment(loan, inp.mortgageRate, inp.mortgageTermYears);
  const termMonths = Math.round(inp.mortgageTermYears * 12);
  const mRate = inp.mortgageRate / 12;
  const disc = inp.investmentReturn / 12;

  const downPayment = inp.homePrice * inp.downPaymentPct;
  const closing = inp.homePrice * inp.buyingClosingPct;

  // Initial outlay happens at t=0, no discount.
  let pv = downPayment + closing;

  let balance = loan;
  const rows: YearRow[] = [];

  // Annual accumulators for the tax-benefit calc and the breakdown table.
  // yrDeductibleInterest is interest scaled month-by-month by the IRC 163(h)(3)
  // acquisition-debt cap (see the loop), separate from yrInterest (cash paid).
  let yrInterest = 0,
    yrDeductibleInterest = 0,
    yrPrincipal = 0,
    yrMortgage = 0,
    yrPropTax = 0,
    yrMaint = 0,
    yrIns = 0,
    yrHoa = 0,
    yrPmi = 0,
    yrTaxBenefit = 0;

  for (let m = 1; m <= months; m++) {
    const yearFrac = m / 12;
    const homeValue = inp.homePrice * Math.pow(1 + inp.homeAppreciation, yearFrac);
    const df = Math.pow(1 + disc, m); // discount factor for end of month m

    // Mortgage split
    let interest = 0;
    let principal = 0;
    let pay = 0;
    if (m <= termMonths && balance > 0) {
      interest = balance * mRate;
      principal = Math.min(payment - interest, balance);
      pay = interest + principal;
      // IRC 163(h)(3): interest is deductible only on the first $750k of
      // acquisition debt (same cap for single/HoH/MFJ; MFS's $375k isn't modeled).
      // Acquisition debt falls as you amortize, so the deductible fraction is
      // recomputed off the current balance and rises to 1 once it's under the cap.
      yrDeductibleInterest += interest * Math.min(1, MORTGAGE_INTEREST_DEBT_CAP / balance);
      balance -= principal;
    }

    // Recurring carrying costs. Percent-of-value items ride the appreciating home
    // value; flat-dollar items (and HOA/utilities) ride inflation instead.
    const infl = Math.pow(1 + inp.inflation, yearFrac);
    const propTax =
      inp.propertyTaxMode === "amount"
        ? (inp.propertyTaxAnnual * infl) / 12
        : (homeValue * inp.propertyTaxRate) / 12;
    const maint =
      inp.maintenanceMode === "amount"
        ? (inp.maintenanceAnnual * infl) / 12
        : (homeValue * inp.maintenanceRate) / 12;
    const ins =
      inp.homeInsuranceMode === "amount"
        ? (inp.homeInsuranceAnnual * infl) / 12
        : (homeValue * inp.homeInsuranceRate) / 12;
    const hoa = inp.hoaMonthly * infl;
    const util = inp.extraUtilitiesMonthly * infl;
    const pmi = balance / inp.homePrice > 0.8 ? (loan * inp.pmiRate) / 12 : 0;

    const monthlyOut = pay + propTax + maint + ins + hoa + util + pmi;
    pv += monthlyOut / df;

    // accumulate for annual rollups
    yrInterest += interest;
    yrPrincipal += principal;
    yrMortgage += pay;
    yrPropTax += propTax;
    yrMaint += maint;
    yrIns += ins;
    yrHoa += hoa + util;
    yrPmi += pmi;

    // Year boundary: credit the tax benefit (itemization premium over standard).
    // Horizons are always whole years (callers round), so every year is full.
    if (m % 12 === 0) {
      const saltUsed = Math.min(yrPropTax + inp.otherSALT, inp.saltCap);
      // PMI is deliberately excluded from itemized deductions. OBBBA restored the
      // mortgage-insurance-premium deduction for 2026+, but it phases out between
      // $100k-$110k AGI and the model has no AGI input (the default 24% marginal
      // rate already implies AGI past the phaseout), so we treat PMI as a pure cost.
      const itemized = yrDeductibleInterest + saltUsed;
      const benefit = inp.marginalTaxRate * Math.max(0, itemized - inp.standardDeduction);
      // credit at end-of-year discount point (use current month's df)
      pv -= benefit / df;
      yrTaxBenefit = benefit;

      if (collectRows) {
        const yIdx = Math.ceil(m / 12);
        rows.push({
          year: yIdx,
          mortgagePaid: yrMortgage,
          interestPaid: yrInterest,
          principalPaid: yrPrincipal,
          propertyTax: yrPropTax,
          maintenance: yrMaint,
          insurance: yrIns,
          hoa: yrHoa,
          pmi: yrPmi,
          taxBenefit: yrTaxBenefit,
          homeValue,
          loanBalance: balance,
          equity: homeValue - balance,
          rentPaid: 0, // placeholder, filled by calculate()
        });
      }
      yrInterest = yrDeductibleInterest = yrPrincipal = yrMortgage = yrPropTax = yrMaint = yrIns = yrHoa = yrPmi = 0;
    }
  }

  // Sale at the horizon (inflow, discounted).
  const saleValue = inp.homePrice * Math.pow(1 + inp.homeAppreciation, horizonYears);
  const sellingCosts = saleValue * inp.sellingCostPct;
  // Basis = purchase price + buying closing costs (symmetric with selling costs).
  const gain = saleValue - sellingCosts - inp.homePrice - closing;
  const exclusion = inp.filingJointly ? 500000 : 250000;
  const taxableGain = Math.max(0, gain - exclusion);
  const capGainsTax = inp.capitalGainsRate * taxableGain;
  const netProceeds = saleValue - sellingCosts - balance - capGainsTax;
  const saleDf = Math.pow(1 + disc, months);
  pv -= netProceeds / saleDf;

  return { pvCost: pv, years: rows, monthlyPayment: payment, loanAmount: loan };
}

/**
 * Present-value cost of renting at a given first-year monthly rent.
 * Linear in `monthlyRent`, which we exploit to solve breakeven in closed form.
 */
function simulateRent(inp: CalcInputs, horizonYears: number, monthlyRent: number): number {
  const months = Math.round(horizonYears * 12);
  const disc = inp.investmentReturn / 12;

  const deposit = monthlyRent * inp.securityDepositMonths;
  const brokerFee = monthlyRent * inp.brokerFeeMonths;
  let pv = deposit + brokerFee;

  for (let m = 1; m <= months; m++) {
    const yearIdx = Math.floor((m - 1) / 12);
    const rent = monthlyRent * Math.pow(1 + inp.rentGrowth, yearIdx);
    const renters = inp.rentersInsuranceMonthly * Math.pow(1 + inp.inflation, m / 12);
    const df = Math.pow(1 + disc, m);
    pv += (rent + renters) / df;
  }

  // Deposit returned at move-out (inflow).
  pv -= deposit / Math.pow(1 + disc, months);
  return pv;
}

/** Closed-form breakeven rent: rent PV is affine in monthlyRent, so solve directly. */
function breakevenRentAt(inp: CalcInputs, horizonYears: number, buyPvCost: number): number {
  const perUnit = simulateRent({ ...inp, rentersInsuranceMonthly: 0 }, horizonYears, 1); // slope
  const fixed = simulateRent({ ...inp, securityDepositMonths: 0, brokerFeeMonths: 0 }, horizonYears, 0); // intercept
  if (perUnit <= 0) return 0;
  return clampPos((buyPvCost - fixed) / perUnit);
}

export function calculate(rawInp: CalcInputs): CalcResult {
  const inp = sanitizeInputs(rawInp);
  const horizon = Math.max(1, Math.round(inp.yearsToStay));

  // Headline: full sim at the chosen horizon, with breakdown rows.
  const buy = simulateBuy(inp, horizon, true);
  const rentNetCost = simulateRent(inp, horizon, inp.monthlyRent);
  const breakevenRent = breakevenRentAt(inp, horizon, buy.pvCost);

  // Fill rentPaid into the breakdown rows.
  const years = buy.years.map((r) => {
    let rentPaid = 0;
    for (let m = (r.year - 1) * 12 + 1; m <= r.year * 12; m++) {
      const yearIdx = Math.floor((m - 1) / 12);
      rentPaid += inp.monthlyRent * Math.pow(1 + inp.rentGrowth, yearIdx);
    }
    return { ...r, rentPaid };
  });

  // Horizon sweep for the chart + breakeven year (when does buying overtake renting?).
  const maxYears = Math.max(horizon, inp.mortgageTermYears, 30);
  const points: HorizonPoint[] = [];
  let breakevenYear: number | null = null;
  for (let y = 1; y <= maxYears; y++) {
    const b = simulateBuy(inp, y, false).pvCost;
    const r = simulateRent(inp, y, inp.monthlyRent);
    points.push({ year: y, buyNetCost: b, rentNetCost: r });
    if (breakevenYear === null && b <= r) breakevenYear = y;
  }

  const verdict: "buy" | "rent" = inp.monthlyRent <= breakevenRent ? "rent" : "buy";

  return {
    breakevenRent,
    verdict,
    monthlyDifference: breakevenRent - inp.monthlyRent,
    buyNetCost: buy.pvCost,
    rentNetCost,
    breakevenYear,
    monthlyPayment: buy.monthlyPayment,
    loanAmount: buy.loanAmount,
    horizon: points,
    years,
  };
}
