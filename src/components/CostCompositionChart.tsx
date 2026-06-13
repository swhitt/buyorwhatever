import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { grossOwningCost, RECURRING_COSTS, type CostKey, type YearRow } from "../engine/calculator";
import { usd, usdCompact } from "../lib/format";
import { niceTicks } from "../lib/ticks";

// Colors for the registry carrying costs. This chart is entirely the BUYING side,
// so orange (= buy) reading as interest is fine, but teal (= rent in the other
// charts) must NOT appear here: principal uses emerald, the credit cyan.
const COST_COLORS: Record<CostKey, string> = {
  propertyTax: "#eab308",
  maintenance: "#8b5cf6",
  insurance: "#3b82f6",
  hoa: "#ec4899",
  pmi: "#ef4444",
};
const INTEREST_COLOR = "#ea580c";
const EQUITY_COLOR = "#10b981";
const CREDIT_COLOR = "#0891b2";

interface StackItem {
  key: string;
  label: string;
  color: string;
  get: (y: YearRow) => number;
}

// Bottom-to-top: interest (the big early cost), then the registry carrying costs,
// then principal as a distinct equity band on top. The carrying-cost slice is derived
// from the cost registry, so a new owning cost appears here without touching this file.
const STACK: StackItem[] = [
  { key: "interest", label: "Interest", color: INTEREST_COLOR, get: (y) => y.interestPaid },
  ...RECURRING_COSTS.filter((c) => c.side === "buy").map(
    (c): StackItem => ({ key: c.key, label: c.label, color: COST_COLORS[c.key], get: (y) => y.costs[c.key] }),
  ),
  { key: "principal", label: "Principal (equity)", color: EQUITY_COLOR, get: (y) => y.principalPaid },
];

interface CompRow {
  year: number;
  taxCredit: number; // negated tax benefit, so it stacks below zero under stackOffset="sign"
  raw: YearRow;
  // Recharts reads each stack item's value by its string key off the row.
  [k: string]: number | YearRow;
}

function CompositionTooltip({
  active,
  payload,
  items,
  showCredit,
}: {
  active?: boolean;
  payload?: { payload: CompRow }[];
  items: StackItem[];
  showCredit: boolean;
}) {
  if (!active || !payload?.length) return null;
  const y = payload[0].payload.raw;
  const cashOut = grossOwningCost(y);
  const netCash = cashOut - y.taxBenefit;
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 text-[13px] shadow-lg">
      <div className="mb-1 text-muted">Year {y.year}</div>
      {items.map((it) => {
        const v = it.get(y);
        if (v <= 0) return null;
        return (
          <div key={it.key} className="flex items-baseline justify-between gap-6">
            <span className="flex items-center gap-1.5 text-muted">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: it.color }} />
              {it.label}
            </span>
            <span className="tnum font-semibold text-ink">{usd(v)}</span>
          </div>
        );
      })}
      {showCredit && y.taxBenefit > 0 && (
        <div className="flex items-baseline justify-between gap-6">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: CREDIT_COLOR }} />
            Tax benefit
          </span>
          <span className="tnum font-semibold" style={{ color: CREDIT_COLOR }}>
            -{usd(y.taxBenefit)}
          </span>
        </div>
      )}
      <div className="mt-1.5 flex items-baseline justify-between gap-6 border-t border-line pt-1.5">
        <span className="text-muted">Out of pocket</span>
        <span className="tnum font-bold text-ink">{usd(netCash)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-6">
        <span className="text-muted">Builds equity</span>
        <span className="tnum font-semibold" style={{ color: EQUITY_COLOR }}>
          {usd(y.principalPaid)}
        </span>
      </div>
    </div>
  );
}

/**
 * Stacked composition of each year's owning payment. Costs stack up from zero;
 * principal (equity) sits on top to separate "money gone" from "money saved";
 * the tax benefit hangs below zero as a credit you net back.
 */
export function CostCompositionChart({ years }: { years: YearRow[] }) {
  // Keep only stack items that ever carry a value, so PMI/HOA vanish when irrelevant.
  const items = STACK.filter((it) => years.some((y) => it.get(y) > 0));
  const showCredit = years.some((y) => y.taxBenefit > 0);

  const rows: CompRow[] = years.map((y) => {
    const row: CompRow = { year: y.year, taxCredit: -y.taxBenefit, raw: y };
    for (const it of items) row[it.key] = it.get(y);
    return row;
  });

  // One x-tick per year up to ~12, then thin them so labels never crowd.
  const stride = Math.ceil(years.length / 12);
  const ticks = years.filter((_, i) => i % stride === 0).map((y) => y.year);

  // Clean, zero-anchored y-ticks across the tallest bar (and the credit dip below 0).
  // Sum via the typed accessor off raw (not the dynamic row key) to stay cast-free.
  const maxTotal = Math.max(...rows.map((r) => items.reduce((s, it) => s + it.get(r.raw), 0)), 0);
  const minTotal = showCredit ? Math.min(...rows.map((r) => r.taxCredit), 0) : 0;
  const yTicks = niceTicks(minTotal, maxTotal);

  const legendItems = [
    ...items.map((it) => ({ label: it.label, color: it.color })),
    ...(showCredit ? [{ label: "Tax benefit", color: CREDIT_COLOR }] : []),
  ];

  return (
    <>
      <div
        className="h-72 w-full sm:h-80"
        role="img"
        aria-label={`Where each year's home payment goes, broken into ${items.map((it) => it.label).join(", ")}${showCredit ? ", less the federal tax benefit" : ""}, over ${years.length} years. Interest is largest early and shrinks as principal grows.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 8, left: 4, bottom: 0 }}
            barCategoryGap="18%"
            stackOffset="sign"
            accessibilityLayer
          >
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis
              dataKey="year"
              ticks={ticks}
              tickLine={false}
              axisLine={{ stroke: "var(--color-line)" }}
              tick={{ fontSize: 12, fill: "var(--color-muted)" }}
              tickFormatter={(y) => `${y}y`}
            />
            <YAxis
              domain={[minTotal, maxTotal]}
              ticks={yTicks}
              tickLine={false}
              axisLine={false}
              width={48}
              tick={{ fontSize: 12, fill: "var(--color-muted)" }}
              tickFormatter={(v) => (v === 0 ? "$0" : usdCompact(v))}
            />
            <Tooltip
              cursor={{ fill: "var(--color-ink)", fillOpacity: 0.04 }}
              content={<CompositionTooltip items={items} showCredit={showCredit} />}
            />
            {showCredit && <ReferenceLine y={0} stroke="var(--color-muted)" strokeWidth={1} />}
            {items.map((it, i) => (
              <Bar
                key={it.key}
                dataKey={it.key}
                stackId="c"
                fill={it.color}
                isAnimationActive={false}
                radius={i === items.length - 1 ? [3, 3, 0, 0] : undefined}
              />
            ))}
            {showCredit && (
              <Bar dataKey="taxCredit" stackId="c" fill={CREDIT_COLOR} isAnimationActive={false} radius={[0, 0, 3, 3]} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
        {legendItems.map((it) => (
          <span key={it.label} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: it.color }} />
            {it.label}
          </span>
        ))}
      </div>
    </>
  );
}
