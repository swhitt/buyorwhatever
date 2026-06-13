import {
  Area,
  CartesianGrid,
  ComposedChart,
  Label,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HorizonPoint } from "../engine/calculator";
import { usd, usdCompact } from "../lib/format";
import { breakevenLabelPosition, niceTicks, yearTicks } from "../lib/ticks";

interface GapRow {
  year: number;
  buy: number; // buyNetCost, carried so the tooltip can show the magnitudes too
  rent: number; // rentNetCost
  gap: number; // rent - buy: positive => buying is ahead by this much
}

/** Rich tooltip: the two totals and the signed advantage between them, in one card. */
function AdvantageTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: GapRow }[];
  label?: number;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const buyAhead = row.gap >= 0;
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 text-[13px] shadow-lg">
      <div className="mb-1 text-muted">
        After {label} year{label === 1 ? "" : "s"}
      </div>
      <div className="flex items-baseline justify-between gap-6">
        <span className="text-buy-text">Buying</span>
        <span className="tnum font-semibold text-ink">{usd(row.buy)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-6">
        <span className="text-rent-text">Renting</span>
        <span className="tnum font-semibold text-ink">{usd(row.rent)}</span>
      </div>
      <div className="mt-1.5 border-t border-line pt-1.5">
        <span className={buyAhead ? "text-buy-text" : "text-rent-text"}>
          {buyAhead ? "Buying" : "Renting"} ahead by{" "}
        </span>
        <span className="tnum font-bold text-ink">{usd(Math.abs(row.gap))}</span>
      </div>
    </div>
  );
}

/**
 * Net-advantage chart: the signed gap between renting and buying, off a zero
 * baseline. The two-line chart shows magnitudes (both lines hug a huge axis, so
 * the crossover is a few pixels); here the whole story is the distance from zero,
 * so the breakeven year reads as the point the area flips sides.
 */
export function AdvantageChart({
  data,
  breakevenYear,
  yearsToStay,
}: {
  data: HorizonPoint[];
  breakevenYear: number | null;
  yearsToStay: number;
}) {
  const rows: GapRow[] = data.map((d) => ({
    year: d.year,
    buy: d.buyNetCost,
    rent: d.rentNetCost,
    gap: d.rentNetCost - d.buyNetCost,
  }));
  const stay = rows.find((r) => r.year === Math.round(yearsToStay));
  const cross = breakevenYear != null ? rows.find((r) => r.year === breakevenYear) : undefined;

  const values = rows.map((r) => r.gap);
  const dataMax = Math.max(...values);
  const dataMin = Math.min(...values);
  // Axis domain: pad past the data and always include zero, so the zero rule sits
  // inside the plot even when one side leads the whole time.
  const pad = Math.max(dataMax - dataMin, 1) * 0.08;
  const domainMax = Math.max(dataMax, 0) + pad;
  const domainMin = Math.min(dataMin, 0) - pad;
  // Gradient split: the fill spans from the curve to the zero baseline, so its
  // bounding box runs [min(dataMin,0), max(dataMax,0)]. The objectBoundingBox
  // gradient maps to THAT box, not the padded axis, so zero's fraction is computed
  // from the clamped extents. All one sign => offset clamps to a solid color.
  const fillTop = Math.max(dataMax, 0);
  const fillBottom = Math.min(dataMin, 0);
  const zeroOffset = fillTop <= fillBottom ? 0 : fillTop / (fillTop - fillBottom);

  const ariaLabel = breakevenYear != null
    ? `Net financial advantage of buying versus renting over ${rows.length} years. Renting stays ahead until year ${breakevenYear}, after which buying is cheaper.`
    : `Net financial advantage of buying versus renting over ${rows.length} years. Renting stays ahead the whole time at this rent.`;

  return (
    <div className="h-72 w-full sm:h-80" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 16, right: 8, left: 4, bottom: 0 }} accessibilityLayer>
          <defs>
            <linearGradient id="advFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset={zeroOffset} stopColor="var(--color-buy)" stopOpacity={0.22} />
              <stop offset={zeroOffset} stopColor="var(--color-rent)" stopOpacity={0.22} />
            </linearGradient>
            <linearGradient id="advStroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset={zeroOffset} stopColor="var(--color-buy)" stopOpacity={1} />
              <stop offset={zeroOffset} stopColor="var(--color-rent)" stopOpacity={1} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis
            dataKey="year"
            tickLine={false}
            axisLine={{ stroke: "var(--color-line)" }}
            tick={{ fontSize: 12, fill: "var(--color-muted)" }}
            tickFormatter={(y) => `${y}y`}
            ticks={yearTicks(rows.length)}
          />
          <YAxis
            domain={[domainMin, domainMax]}
            ticks={niceTicks(domainMin, domainMax)}
            tickLine={false}
            axisLine={false}
            width={48}
            tick={{ fontSize: 12, fill: "var(--color-muted)" }}
            tickFormatter={(v) => (v === 0 ? "$0" : usdCompact(v))}
          />
          <Tooltip cursor={{ stroke: "var(--color-muted)", strokeDasharray: "3 3" }} content={<AdvantageTooltip />} />
          {/* Zero line is the whole point: above it buying wins, below it renting wins. */}
          <ReferenceLine y={0} stroke="var(--color-muted)" strokeWidth={1.5} />
          <Area
            type="monotone"
            dataKey="gap"
            name="gap"
            stroke="url(#advStroke)"
            strokeWidth={2.5}
            fill="url(#advFill)"
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
          {/* Breakeven: a full-height guide plus a labeled marker right on the crossing,
              so the label sits near mid-height (clear of the top axis tick). */}
          {breakevenYear != null && (
            <ReferenceLine x={breakevenYear} stroke="var(--color-muted)" strokeDasharray="4 4" />
          )}
          {cross && (
            <ReferenceDot x={cross.year} y={cross.gap} r={4} fill="var(--color-ink)" stroke="var(--color-paper)" strokeWidth={2}>
              <Label
                value={`breakeven ${breakevenYear}y`}
                position={breakevenLabelPosition(breakevenYear!, rows.length)}
                fontSize={11}
                fill="var(--color-muted)"
              />
            </ReferenceDot>
          )}
          {/* The user's chosen horizon, ringed in paper, annotated with the advantage there. */}
          {stay && (
            <ReferenceDot
              x={stay.year}
              y={stay.gap}
              r={4.5}
              fill={stay.gap >= 0 ? "var(--color-buy)" : "var(--color-rent)"}
              stroke="var(--color-paper)"
              strokeWidth={2}
            >
              <Label
                value={`your stay · ${usdCompact(Math.abs(stay.gap))}`}
                position={stay.gap >= 0 ? "top" : "bottom"}
                fontSize={11}
                fill="var(--color-muted)"
              />
            </ReferenceDot>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
