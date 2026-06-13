import type { YearRow } from "../engine/calculator";
import { usd } from "../lib/format";

export function Breakdown({ years }: { years: YearRow[] }) {
  const cols: { key: keyof YearRow; label: string; tone?: "buy" | "rent" | "good" }[] = [
    { key: "mortgagePaid", label: "Mortgage" },
    { key: "interestPaid", label: "of which interest" },
    { key: "propertyTax", label: "Property tax" },
    { key: "maintenance", label: "Maintenance" },
    { key: "insurance", label: "Insurance" },
    { key: "pmi", label: "PMI" },
    { key: "taxBenefit", label: "Tax benefit", tone: "good" },
    { key: "rentPaid", label: "Rent (alt.)", tone: "rent" },
    { key: "homeValue", label: "Home value" },
    { key: "equity", label: "Your equity", tone: "good" },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full min-w-[640px] border-collapse text-right text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-3 text-left font-semibold">Year</th>
            {cols.map((c) => (
              <th key={c.key} className="px-2 py-2 font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.year} className="border-b border-line/60 last:border-0 hover:bg-paper">
              <td className="py-2 pr-3 text-left font-semibold">{y.year}</td>
              {cols.map((c) => {
                const v = y[c.key] as number;
                const cls =
                  c.tone === "good"
                    ? "text-rent"
                    : c.tone === "rent"
                      ? "text-muted"
                      : "text-ink";
                return (
                  <td key={c.key} className={"px-2 py-2 " + cls}>
                    {c.key === "taxBenefit" && v > 0 ? `+${usd(v)}` : usd(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
