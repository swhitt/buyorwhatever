# Breakeven

A rent-vs-buy calculator with live mortgage rates, home prices, and rents baked into a static site, and a year-by-year breakdown of every cost. The model lives in the repo. No accounts, no ads, no lead-gen.

## What it does

Enter a location (or your own numbers) and it computes the **breakeven monthly rent**: the rent at which buying and renting cost exactly the same. Rent a comparable home for less and renting wins; more and buying wins. It also finds the **breakeven horizon**, the number of years you'd need to stay before owning pulls ahead.

Every cost of owning (mortgage interest and principal, property tax, maintenance, insurance, PMI, HOA, closing and selling costs, and the investment return you give up by tying money in a down payment) is converted into rent-equivalent dollars and discounted at your investment-return rate.

Don't know your tax bracket? Enter your income, filing status, and state and it estimates your marginal rate (federal + state, plus an optional local field). The mortgage-interest and property-tax deduction is valued at your **federal** marginal rate (it's a federal Schedule A deduction), and your estimated state and local income tax feeds the SALT base, so the deduction math reflects your situation instead of a guess. Property tax, maintenance, and insurance can each be entered as a percent of home value or a flat dollar figure, whichever you know. A **"show how your rates are derived"** panel exposes the exact federal and state brackets applied (your row highlighted), whether you itemize, and the live source behind every headline number.

**Shareable.** Every metro and ZIP has its own URL (`breakeven.rent/houston-tx`, `breakeven.rent/77002`) that loads that location and unfurls with its own verdict card; `breakeven.rent/calc` is a stripped-down four-input quick answer. Any tweaks you make are encoded into a `?s=` link so you can share an exact scenario.

## The model

It uses a four-bucket cost decomposition (initial costs, recurring costs, opportunity costs, net sale proceeds), grounded in the user-cost-of-homeownership literature (Himmelberg, Mayer & Sinai, 2005). The engine is a pure, unit-tested module in [`src/engine/calculator.ts`](src/engine/calculator.ts). The simulation runs monthly for accurate amortization, PMI drop-off, and compounding.

Outputs:

- **Breakeven rent** at your chosen horizon (solved in closed form, since rent enters the cost linearly).
- **Breakeven horizon**: the first year buying's net cost drops below renting's at the rent you entered.
- A **net-worth comparison**: your home equity (after selling costs) vs. renting and investing the difference (the down payment plus every year's cash-flow gap, compounded at your return). Derived from the same present values, so the wealth lines cross in the exact year the cost lines do.
- A year-by-year breakdown so you can audit every line, with a **CSV export** of the full dataset (every field, derived cumulatives, the PV crossover, and a self-documenting header of your assumptions).

## Live data

A scheduled GitHub Action pulls fresh public data weekly (and on demand), then bakes it into JSON the static site reads. No server at runtime.

| Input | Source |
| --- | --- |
| Mortgage rates (30/15 yr) | Freddie Mac PMMS |
| Home prices & rents | Zillow ZHVI / ZORI (400+ metros, plus ~8k ZIP codes) |
| Inflation | BLS CPI-U |
| Home-price appreciation | Conservative long-run default; the local 5-year CAGR (Zillow ZHVI) is offered as a one-tap alternative |
| Property tax by state | WalletHub / Census ACS (2024 median effective rates) |
| Home insurance by state | NAIC HO-3 premiums / Zillow ZHVI (effective rate) |
| Income tax (marginal) | IRS 2026 federal brackets, Tax Foundation / state DOR tables (50 states + DC) |
| Capital-gains exclusion | IRS Topic 701 |

The fetcher ([`scripts/fetch-data.mjs`](scripts/fetch-data.mjs)) is zero-dependency Node. Each source is fetched independently and falls back to the last committed value if it's unreachable, so a flaky upstream never breaks a deploy.

**Location-aware.** The site auto-detects the visitor's metro from a keyless IP lookup on first load (silent fallback to the national figures, choice remembered in `localStorage`), then prefills home price, rent, property tax, and insurance for that location.

**Self-refreshing.** On load the page also pulls the latest `market.json` (mortgage rates, inflation, national price/rent, appreciation) from the repo's jsDelivr CDN mirror, falling back to the bundled copy on any failure, so the headline numbers stay current between deploys without a rebuild. Those two keyless GETs (geo + market) are the only runtime network calls; everything else is baked at build time. To force a refresh, run the **Refresh data** GitHub Action (`workflow_dispatch`), which pulls fresh figures, commits them, and purges the CDN. Its weekly cron keeps things current automatically.

**Historical record.** Each sync appends a dated national snapshot (rates, prices, rent, inflation, appreciation) to [`src/data/history.json`](src/data/history.json), deduped by date. CI commits it back, so a time series accumulates across the weekly runs.

## Develop

```bash
npm install
npm run fetch-data   # refresh market + metro data from live sources (optional)
npm run fetch-zips   # refresh the ZIP-level home value / rent table (optional, ~128MB pull)
npm run dev          # local dev server
npm test             # engine + lib unit tests
npm run build        # production build to dist/ (incl. per-metro/ZIP prerender)
```

## Deploy

The site is a static SPA hosted on [Vercel](https://breakeven.rent), shipped with `vercel --prod`. The build's postbuild step ([`scripts/gen-og-pages.tsx`](scripts/gen-og-pages.tsx)) prerenders a page per metro and per ZIP, each with metro/ZIP-specific meta, so a shared `/houston-tx` or `/77002` link unfurls with that location's verdict. The top markets also get a rendered Open Graph card image stored in Vercel Blob.

Two GitHub Actions keep things honest: [`ci.yml`](.github/workflows/ci.yml) typechecks, tests, and builds on every push; [`refresh-data.yml`](.github/workflows/refresh-data.yml) runs weekly (and on demand) to pull fresh figures, commit them, re-render the top OG cards, and purge the CDN.

## Caveats

The SALT cap, standard deduction, and capital-gains brackets are simplified and change with tax law, so treat the deduction math as an estimate. The marginal-rate estimator uses 2026 federal and state brackets applied to income net of the federal standard deduction (each state's own deductions vary), and excludes city/county income taxes unless you add them in the local field, so it's a close estimate rather than a tax return. Property tax and home insurance are state-level effective rates (they vary within a state by county/municipality). Home appreciation defaults to a conservative long-run figure rather than recent local run-ups (which overstate the future). The investment-return rate does double duty as the discount rate, so uncertain flows (appreciation) and certain ones (mortgage payments) are discounted at the same risk-blind rate, a deliberate simplification. This is a decision aid, not financial advice.

## License

MIT
