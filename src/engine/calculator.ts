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

import { CAPITAL_GAINS_EXCLUSION, MORTGAGE_INTEREST_DEBT_CAP } from "./taxConstants";

/**
 * How a recurring ownership cost is expressed. A tagged union so only one
 * representation exists at a time (no stale sibling field):
 *   pctOfValue - a fraction of the *current* (appreciating) home value / yr.
 *   flatAnnual - a flat dollar figure / yr in today's dollars, grown with inflation
 *                (useful where assessment caps decouple the bill from market value).
 */
export type CostBasis = { kind: "pctOfValue"; rate: number } | { kind: "flatAnnual"; annual: number };

/** Monthly cost from a basis: %-of-value rides the home value, flat rides inflation. */
export function monthlyCostFromBasis(basis: CostBasis, homeValue: number, inflationFactor: number): number {
  return basis.kind === "flatAnnual"
    ? (Math.max(0, basis.annual) * inflationFactor) / 12
    : (homeValue * Math.max(0, basis.rate)) / 12;
}

export interface CalcInputs {
  // Purchase
  homePrice: number;
  downPaymentPct: number; // fraction, e.g. 0.2
  mortgageRate: number; // annual, e.g. 0.0652
  mortgageTermYears: number; // e.g. 30
  homeAppreciation: number; // annual, e.g. 0.03

  // Horizon & money
  yearsToStay: number; // e.g. 9
  // Does double duty (on purpose): the opportunity cost of the down payment AND the
  // discount rate for every cash flow. So mortgage and uncertain-appreciation flows
  // are discounted at the same risk-blind rate, a deliberate simplification.
  investmentReturn: number; // annual opportunity / discount rate, e.g. 0.05
  inflation: number; // annual, e.g. 0.024

  // Recurring ownership costs. Property tax, maintenance, and insurance each carry
  // a CostBasis (percent-of-value or flat-annual); see CostBasis above.
  propertyTax: CostBasis;
  maintenance: CostBasis;
  homeInsurance: CostBasis;
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

/**
 * Recurring carrying costs of owning, as a registry the simulation, the breakdown
 * table, and the composition chart all read from. Adding a cost (or, later, a
 * rent-side cost like moving expenses) is a single entry here instead of a hand-
 * synced edit across the loop, the row shape, the chart buckets, and the table.
 */
export type CostKey = "propertyTax" | "maintenance" | "insurance" | "hoa" | "pmi";

export interface CostContext {
  homePrice: number;
  homeValue: number; // current (appreciated) value
  inflationFactor: number; // (1 + inflation)^yearFraction
  loanBalance: number; // after this month's principal
  originalLoan: number;
}

export interface RecurringCost {
  key: CostKey;
  label: string;
  side: "buy" | "rent";
  deductibleSALT?: boolean; // counts toward the SALT itemized base (capped)
  inHousingPayment?: boolean; // part of the all-in monthly housing payment (excludes maintenance)
  monthly: (inp: CalcInputs, ctx: CostContext) => number;
}

export const RECURRING_COSTS: RecurringCost[] = [
  {
    key: "propertyTax",
    label: "Property tax",
    side: "buy",
    deductibleSALT: true,
    inHousingPayment: true,
    monthly: (i, c) => monthlyCostFromBasis(i.propertyTax, c.homeValue, c.inflationFactor),
  },
  {
    key: "maintenance",
    label: "Maintenance",
    side: "buy",
    monthly: (i, c) => monthlyCostFromBasis(i.maintenance, c.homeValue, c.inflationFactor),
  },
  {
    key: "insurance",
    label: "Insurance",
    side: "buy",
    inHousingPayment: true,
    monthly: (i, c) => monthlyCostFromBasis(i.homeInsurance, c.homeValue, c.inflationFactor),
  },
  {
    // HOA dues plus the owning-vs-renting utilities delta, both inflation-grown.
    key: "hoa",
    label: "HOA / other",
    side: "buy",
    inHousingPayment: true,
    monthly: (i, c) => (i.hoaMonthly + i.extraUtilitiesMonthly) * c.inflationFactor,
  },
  {
    // While LTV (against the original price) is over 80%, charged on the original loan.
    key: "pmi",
    label: "PMI",
    side: "buy",
    inHousingPayment: true,
    monthly: (i, c) => (c.loanBalance / c.homePrice > 0.8 ? (c.originalLoan * i.pmiRate) / 12 : 0),
  },
];

const BUY_COSTS = RECURRING_COSTS.filter((c) => c.side === "buy");

/** A fresh per-cost accumulator zeroed for every registry key. */
function zeroCosts(): Record<CostKey, number> {
  return Object.fromEntries(RECURRING_COSTS.map((c) => [c.key, 0])) as Record<CostKey, number>;
}

// Year-row aggregations live next to the row so every view derives the same number
// from one place instead of re-spelling the sum (and silently dropping a new cost).

/** Total recurring carrying costs for the year (every registry bucket). */
export const sumCosts = (y: YearRow): number => Object.values(y.costs).reduce((s, n) => s + n, 0);

/** Gross annual cash cost of owning: mortgage plus all carrying costs, before tax. */
export const grossOwningCost = (y: YearRow): number => y.mortgagePaid + sumCosts(y);

/** Net annual cash cost of owning: gross less the federal tax benefit. */
export const netOwningCost = (y: YearRow): number => grossOwningCost(y) - y.taxBenefit;

/** The carrying costs that make up the all-in monthly housing payment (property tax,
 *  insurance, HOA, PMI; NOT maintenance), as {label, monthly} pairs for the year. */
export const housingPaymentLines = (y: YearRow): { label: string; monthly: number }[] =>
  BUY_COSTS.filter((c) => c.inHousingPayment).map((c) => ({ label: c.label, monthly: y.costs[c.key] / 12 }));

export interface YearRow {
  year: number;
  // buy
  mortgagePaid: number;
  interestPaid: number;
  principalPaid: number;
  costs: Record<CostKey, number>; // recurring carrying costs for the year, keyed by registry
  taxBenefit: number; // positive = money back (itemization premium over the standard deduction)
  // The two itemized-deduction components the tax benefit is built from, exposed so the
  // "show your work" panel narrates the engine's actual numbers instead of re-deriving them.
  deductibleInterest: number; // mortgage interest left deductible after the 163(h)(3) cap
  saltUsed: number; // property tax + other SALT, after the SALT cap
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
    yrTaxBenefit = 0;
  let yrCosts = zeroCosts();

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

    // Recurring carrying costs from the registry. Percent-of-value items ride the
    // appreciating home value; flat-dollar items (and HOA/utilities) ride inflation.
    const infl = Math.pow(1 + inp.inflation, yearFrac);
    const ctx: CostContext = {
      homePrice: inp.homePrice,
      homeValue,
      inflationFactor: infl,
      loanBalance: balance, // post-amortization, for the PMI LTV test
      originalLoan: loan,
    };
    let recurring = 0;
    for (const c of BUY_COSTS) {
      const amt = c.monthly(inp, ctx);
      yrCosts[c.key] += amt;
      recurring += amt;
    }

    const monthlyOut = pay + recurring;
    pv += monthlyOut / df;

    yrInterest += interest;
    yrPrincipal += principal;
    yrMortgage += pay;

    // Year boundary: credit the tax benefit (itemization premium over standard).
    // Horizons are always whole years (callers round), so every year is full.
    if (m % 12 === 0) {
      const saltBase = BUY_COSTS.reduce((s, c) => (c.deductibleSALT ? s + yrCosts[c.key] : s), 0);
      const saltUsed = Math.min(saltBase + inp.otherSALT, inp.saltCap);
      // PMI is deliberately excluded from itemized deductions. OBBBA restored the
      // mortgage-insurance-premium deduction for 2026+, but it phases out between
      // $100k-$110k AGI and the model has no AGI input (the default 24% marginal
      // rate already implies AGI past the phaseout), so we treat PMI as a pure cost.
      // ASSUMPTION: standardDeduction, saltCap, and otherSALT are held at their
      // entry-year nominal value for the whole horizon, while the itemized total
      // inflates with the home. Real law indexes these, so this slightly overstates
      // the long-horizon benefit for high-tax itemizers (it's $0, and so unaffected,
      // for the common standard-deduction-wins case). Held flat on purpose; revisit
      // if the horizon-tilt matters. The premium is also valued at a single marginal
      // rate (a small overstatement when it straddles a bracket).
      const itemized = yrDeductibleInterest + saltUsed;
      const benefit = inp.marginalTaxRate * Math.max(0, itemized - inp.standardDeduction);
      pv -= benefit / df;
      yrTaxBenefit = benefit;

      if (collectRows) {
        const yIdx = Math.ceil(m / 12);
        rows.push({
          year: yIdx,
          mortgagePaid: yrMortgage,
          interestPaid: yrInterest,
          principalPaid: yrPrincipal,
          costs: yrCosts,
          taxBenefit: yrTaxBenefit,
          deductibleInterest: yrDeductibleInterest,
          saltUsed,
          homeValue,
          loanBalance: balance,
          equity: homeValue - balance,
          rentPaid: 0, // placeholder, filled by calculate()
        });
      }
      yrInterest = yrDeductibleInterest = yrPrincipal = yrMortgage = 0;
      yrCosts = zeroCosts();
    }
  }

  // Sale at the horizon (inflow, discounted).
  const saleValue = inp.homePrice * Math.pow(1 + inp.homeAppreciation, horizonYears);
  const sellingCosts = saleValue * inp.sellingCostPct;
  // Basis = purchase price + buying closing costs (symmetric with selling costs).
  const gain = saleValue - sellingCosts - inp.homePrice - closing;
  const exclusion = inp.filingJointly ? CAPITAL_GAINS_EXCLUSION.joint : CAPITAL_GAINS_EXCLUSION.single;
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
  // slope: rent-proportional flows only (zero renters insurance, the one rent-independent cost)
  const perUnit = simulateRent({ ...inp, rentersInsuranceMonthly: 0 }, horizonYears, 1);
  // intercept: rent-independent flows only (zero deposit/broker, which scale with rent)
  const fixed = simulateRent({ ...inp, securityDepositMonths: 0, brokerFeeMonths: 0 }, horizonYears, 0);
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
