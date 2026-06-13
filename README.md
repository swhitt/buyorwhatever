# Breakeven

A rent-vs-buy calculator with live mortgage rates, home prices, and rents baked into a static site, and a year-by-year breakdown of every cost. The model lives in the repo. No accounts, no ads, no lead-gen.

## What it does

Enter a location (or your own numbers) and it computes the **breakeven monthly rent**: the rent at which buying and renting cost exactly the same. Rent a comparable home for less and renting wins; more and buying wins. It also finds the **breakeven horizon**, the number of years you'd need to stay before owning pulls ahead.

Every cost of owning (mortgage interest and principal, property tax, maintenance, insurance, PMI, HOA, closing and selling costs, and the investment return you give up by tying money in a down payment) is converted into rent-equivalent dollars and discounted at your investment-return rate.

Don't know your tax bracket? Enter your income, filing status, and state and it estimates your marginal rate (federal + state, plus an optional local field). The mortgage-interest and property-tax deduction is valued at your **federal** marginal rate (it's a federal Schedule A deduction), and your estimated state and local income tax feeds the SALT base, so the deduction math reflects your situation instead of a guess. Property tax, maintenance, and insurance can each be entered as a percent of home value or a flat dollar figure, whichever you know. A **"show how your rates are derived"** panel exposes the exact federal and state brackets applied (your row highlighted), whether you itemize, and the live source behind every headline number.

## The model

It uses a four-bucket cost decomposition (initial costs, recurring costs, opportunity costs, net sale proceeds), grounded in the user-cost-of-homeownership literature (Himmelberg, Mayer & Sinai, 2005). The engine is a pure, unit-tested module in [`src/engine/calculator.ts`](src/engine/calculator.ts). The simulation runs monthly for accurate amortization, PMI drop-off, and compounding.

Outputs:

- **Breakeven rent** at your chosen horizon (solved in closed form, since rent enters the cost linearly).
- **Breakeven horizon**: the first year buying's net cost drops below renting's at the rent you entered.
- A year-by-year breakdown so you can audit every line.

## Live data

A scheduled GitHub Action pulls fresh public data on each deploy and weekly thereafter, then bakes it into JSON the static site reads. No server at runtime.

| Input | Source |
| --- | --- |
| Mortgage rates (30/15 yr) | Freddie Mac PMMS |
| Home prices & rents (400+ metros) | Zillow ZHVI / ZORI |
| Inflation | BLS CPI-U |
| Home-price appreciation | Zillow ZHVI national CAGR |
| Property tax by state | WalletHub / Census ACS (2024 median effective rates) |
| Home insurance by state | NAIC HO-3 premiums / Zillow ZHVI (effective rate) |
| Income tax (marginal) | IRS 2026 federal brackets, Tax Foundation / state DOR tables (50 states + DC) |
| Capital-gains exclusion | IRS Topic 701 |

The fetcher ([`scripts/fetch-data.mjs`](scripts/fetch-data.mjs)) is zero-dependency Node. Each source is fetched independently and falls back to the last committed value if it's unreachable, so a flaky upstream never breaks a deploy.

**Location-aware.** The site auto-detects the visitor's metro from a keyless IP lookup on first load (silent fallback to the national figures, choice remembered in `localStorage`), then prefills home price, rent, property tax, and insurance for that location.

**Self-refreshing.** On load the page also pulls the latest `market.json` (mortgage rates, inflation, national price/rent, appreciation) from the repo's jsDelivr CDN mirror, falling back to the bundled copy on any failure, so the headline numbers stay current between deploys without a rebuild. Those two keyless GETs (geo + market) are the only runtime network calls; everything else is baked at build time. To force a refresh, run the **Refresh data** GitHub Action (`workflow_dispatch`), which pulls fresh figures, commits them, and purges the CDN. The weekly cron on the deploy workflow keeps things current automatically.

**Historical record.** Each sync appends a dated national snapshot (rates, prices, rent, inflation, appreciation) to [`src/data/history.json`](src/data/history.json), deduped by date. CI commits it back, so a time series accumulates across the weekly runs.

## Develop

```bash
npm install
npm run fetch-data   # refresh src/data/*.json from live sources (optional)
npm run dev          # local dev server
npm test             # engine unit tests
npm run build        # production build to dist/
```

## Deploy

Push to `main`. The [workflow](.github/workflows/deploy.yml) installs deps, pulls fresh data, runs tests, builds, and publishes to GitHub Pages. The base path is derived from the repo name automatically, so a fork just works. A weekly cron keeps the data current without any commits.

To enable Pages on a fresh repo: Settings → Pages → Source: **GitHub Actions**.

## Caveats

The SALT cap, standard deduction, and capital-gains brackets are simplified and change with tax law, so treat the deduction math as an estimate. The marginal-rate estimator uses 2026 federal and state brackets applied to income net of the federal standard deduction (each state's own deductions vary), and excludes city/county income taxes unless you add them in the local field, so it's a close estimate rather than a tax return. Home appreciation defaults to a conservative long-run figure rather than recent local run-ups (which overstate the future). This is a decision aid, not financial advice.

## License

MIT
