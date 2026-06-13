# buyorwhatever

A free, open rent-vs-buy calculator that shows its work. Live mortgage rates, home prices, and rents are baked in fresh, the model is fully transparent, and there's no lead-gen or paywall.

Built to outdo the paywalled ones.

## What it does

Enter a location (or your own numbers) and it computes the **breakeven monthly rent**: the rent at which buying and renting cost exactly the same. Rent a comparable home for less and renting wins; more and buying wins. It also finds the **breakeven horizon**, the number of years you'd need to stay before owning pulls ahead.

Every cost of owning (mortgage interest and principal, property tax, maintenance, insurance, PMI, HOA, closing and selling costs, and the investment return you give up by tying money in a down payment) is converted into rent-equivalent dollars and discounted at your investment-return rate.

## The model

It follows the NYT "Is It Better to Rent or Buy?" four-bucket approach (initial costs, recurring costs, opportunity costs, net sale proceeds), grounded in the user-cost-of-homeownership literature (Himmelberg, Mayer & Sinai, 2005). The engine is a pure, unit-tested module in [`src/engine/calculator.ts`](src/engine/calculator.ts). The simulation runs monthly for accurate amortization, PMI drop-off, and compounding.

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
| Property tax by state | Tax Foundation (2024 effective rates) |
| Capital-gains exclusion | IRS Topic 701 |

The fetcher ([`scripts/fetch-data.mjs`](scripts/fetch-data.mjs)) is zero-dependency Node. Each source is fetched independently and falls back to the last committed value if it's unreachable, so a flaky upstream never breaks a deploy.

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

The SALT cap, standard deduction, and capital-gains brackets are simplified and change with tax law, so treat the deduction math as an estimate. Home appreciation defaults to a conservative long-run figure rather than recent local run-ups (which overstate the future). This is a decision aid, not financial advice.

## License

MIT
