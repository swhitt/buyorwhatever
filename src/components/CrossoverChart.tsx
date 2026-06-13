import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HorizonPoint } from "../engine/calculator";
import { usd, usdCompact } from "../lib/format";

interface Row extends HorizonPoint {
  gap: number;
}

export function CrossoverChart({
  data,
  breakevenYear,
  yearsToStay,
}: {
  data: HorizonPoint[];
  breakevenYear: number | null;
  yearsToStay: number;
}) {
  const rows: Row[] = data.map((d) => ({ ...d, gap: d.buyNetCost - d.rentNetCost }));
  const cross = breakevenYear ? rows.find((r) => r.year === breakevenYear) : undefined;

  return (
    <div className="h-72 w-full sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 10, right: 8, left: 4, bottom: 0 }}>
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
            ticks={[1, 5, 10, 15, 20, 25, 30].filter((t) => t <= rows.length)}
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
              fontSize: 13,
              boxShadow: "0 8px 24px rgb(0 0 0 / 0.10)",
            }}
            formatter={(value: number, name) => [usd(value), name === "buyNetCost" ? "Buying" : "Renting"]}
            labelFormatter={(y) => `After ${y} year${y === 1 ? "" : "s"}`}
          />
          <Area
            type="monotone"
            dataKey="rentNetCost"
            name="rentNetCost"
            stroke="var(--color-rent)"
            strokeWidth={2.5}
            fill="url(#rentFill)"
            dot={false}
            activeDot={{ r: 4 }}
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
          />
          {/* faint marker for the user's chosen horizon */}
          <Line dataKey={() => null} dot={false} legendType="none" />
          {cross && (
            <ReferenceDot
              x={cross.year}
              y={cross.buyNetCost}
              r={5}
              fill="var(--color-ink)"
              stroke="var(--color-paper)"
              strokeWidth={2}
            />
          )}
          {(() => {
            const stay = rows.find((r) => r.year === Math.round(yearsToStay));
            return stay ? (
              <ReferenceDot x={stay.year} y={stay.buyNetCost} r={3.5} fill="var(--color-buy)" stroke="none" />
            ) : null;
          })()}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
