import type { YearRow } from "../engine/calculator";
import { usd } from "../lib/format";

export function Breakdown({ years }: { years: YearRow[] }) {
  const cols: { key: keyof YearRow; label: string; tone?: "buy" | "rent" | "good"; hint?: string }[] = [
    { key: "mortgagePaid", label: "Mortgage" },
    { key: "interestPaid", label: "Interest" },
    { key: "propertyTax", label: "Property tax" },
    { key: "maintenance", label: "Maintenance" },
    { key: "insurance", label: "Insurance" },
    { key: "pmi", label: "PMI" },
    {
      key: "taxBenefit",
      label: "Tax benefit",
      tone: "good",
      hint: "Federal tax saved by itemizing (mortgage interest + SALT) vs. taking the standard deduction.",
    },
    { key: "rentPaid", label: "Rent (alt.)", tone: "rent" },
    { key: "homeValue", label: "Home value" },
    { key: "equity", label: "Your equity", tone: "good" },
  ];

  // Drop the PMI column when there's no PMI in any year (20%+ down, or it already
  // dropped off), so it isn't a column of zeros taking up room.
  const visibleCols = years.some((y) => y.pmi > 0) ? cols : cols.filter((c) => c.key !== "pmi");

  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full min-w-[880px] border-collapse text-right text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="sticky left-0 z-10 bg-surface py-2 pr-3 text-left font-semibold">Year</th>
            {visibleCols.map((c) => (
              <th
                key={c.key}
                title={c.hint}
                className={"whitespace-nowrap px-3 py-2 font-semibold" + (c.hint ? " cursor-help" : "")}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y.year} className="group border-b border-line/60 last:border-0">
              <td className="sticky left-0 z-10 bg-surface py-2 pr-3 text-left font-semibold group-hover:bg-paper">
                {y.year}
              </td>
              {visibleCols.map((c) => {
                const v = y[c.key] as number;
                const cls =
                  c.tone === "good" ? "text-rent-text" : c.tone === "rent" ? "text-muted" : "text-ink";
                return (
                  <td key={c.key} className={"whitespace-nowrap px-3 py-2 group-hover:bg-paper " + cls}>
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
