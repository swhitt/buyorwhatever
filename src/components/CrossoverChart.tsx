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
import { breakevenLabelPosition, yearTicks } from "../lib/ticks";

export function CrossoverChart({
  data,
  breakevenYear,
  yearsToStay,
}: {
  data: HorizonPoint[];
  breakevenYear: number | null;
  yearsToStay: number;
}) {
  const rows = data;
  const cross = breakevenYear ? rows.find((r) => r.year === breakevenYear) : undefined;
  const stay = rows.find((r) => r.year === Math.round(yearsToStay));

  // Screen-reader summary of the takeaway, from data the chart already has.
  const ariaLabel = breakevenYear
    ? `Net cost of buying versus renting over ${rows.length} years. The two lines cross at year ${breakevenYear}, after which buying is cheaper.`
    : `Net cost of buying versus renting over ${rows.length} years. Buying never overtakes renting at this rent.`;

  return (
    <div className="h-72 w-full sm:h-80" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 16, right: 8, left: 4, bottom: 0 }} accessibilityLayer>
          <defs>
            <linearGradient id="buyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-buy)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--color-buy)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="rentFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-rent)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--color-rent)" stopOpacity={0} />
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
            tickLine={false}
            axisLine={false}
            width={48}
            tick={{ fontSize: 12, fill: "var(--color-muted)" }}
            tickFormatter={(v) => usdCompact(v)}
          />
          <Tooltip
            cursor={{ stroke: "var(--color-muted)", strokeDasharray: "3 3" }}
            contentStyle={{
              borderRadius: 12,
              border: "1px solid var(--color-line)",
              backgroundColor: "var(--color-surface)",
              color: "var(--color-ink)",
              fontSize: 13,
              boxShadow: "0 8px 24px rgb(0 0 0 / 0.10)",
            }}
            labelStyle={{ color: "var(--color-muted)" }}
            itemStyle={{ color: "var(--color-ink)" }}
            formatter={(value: number, name) => [usd(value), name === "buyNetCost" ? "Buying" : "Renting"]}
            labelFormatter={(y) => `After ${y} year${y === 1 ? "" : "s"}`}
          />
          {/* Renting is dashed so the two series differ by pattern, not just hue. */}
          <Area
            type="monotone"
            dataKey="rentNetCost"
            name="rentNetCost"
            stroke="var(--color-rent)"
            strokeWidth={2.5}
            strokeDasharray="6 4"
            fill="url(#rentFill)"
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="buyNetCost"
            name="buyNetCost"
            stroke="var(--color-buy)"
            strokeWidth={2.5}
            fill="url(#buyFill)"
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
          {/* Breakeven: a full-height guide plus a labeled crossover dot. The label
              rides the dot (mid-chart) so it stays clear of the top y-axis tick. */}
          {breakevenYear != null && (
            <ReferenceLine x={breakevenYear} stroke="var(--color-muted)" strokeDasharray="4 4" />
          )}
          {cross && (
            <ReferenceDot x={cross.year} y={cross.buyNetCost} r={5} fill="var(--color-ink)" stroke="var(--color-paper)" strokeWidth={2}>
              <Label
                value={`breakeven ${breakevenYear}y`}
                position={breakevenLabelPosition(breakevenYear!, rows.length)}
                fontSize={11}
                fill="var(--color-muted)"
              />
            </ReferenceDot>
          )}
          {/* The user's chosen horizon, ringed in paper so it lifts off the line. */}
          {stay && (
            <ReferenceDot x={stay.year} y={stay.buyNetCost} r={4.5} fill="var(--color-buy)" stroke="var(--color-paper)" strokeWidth={2}>
              <Label value="your stay" position="bottom" fontSize={11} fill="var(--color-muted)" />
            </ReferenceDot>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
