import { Fragment, useState } from "react";
import { netOwningCost, RECURRING_COSTS, type YearRow } from "../engine/calculator";
import { usd } from "../lib/format";

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={"inline h-4 w-4 transition-transform " + (open ? "rotate-180" : "")}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Detail({ y }: { y: YearRow }) {
  const items: { label: string; value: number; good?: boolean; hint?: string }[] = [
    { label: "Mortgage", value: y.mortgagePaid },
    { label: "Interest", value: y.interestPaid },
    { label: "Principal", value: y.principalPaid },
    // Recurring carrying costs straight from the registry; zero ones (PMI/HOA) drop out.
    ...RECURRING_COSTS.filter((c) => c.side === "buy" && y.costs[c.key] > 0).map((c) => ({
      label: c.label,
      value: y.costs[c.key],
    })),
    {
      label: "Tax benefit",
      value: y.taxBenefit,
      good: true,
      hint: "Federal tax saved by itemizing (mortgage interest + SALT) vs. the standard deduction.",
    },
    { label: "Home value", value: y.homeValue },
    { label: "Loan balance", value: y.loanBalance },
    { label: "Your equity", value: y.equity, good: true },
    { label: "Rent (alternative)", value: y.rentPaid },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline justify-between gap-3">
          <dt className={"text-xs text-muted" + (it.hint ? " cursor-help" : "")} title={it.hint}>
            {it.label}
          </dt>
          <dd className={"tnum text-sm font-medium " + (it.good ? "text-rent-text" : "text-ink")}>
            {it.good && it.value > 0 ? `+${usd(it.value)}` : usd(it.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Breakdown({ years }: { years: YearRow[] }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (year: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });

  return (
    <div className="overflow-x-auto">
      <p className="mb-3 text-xs text-muted">Tap any year for the full line-by-line breakdown.</p>
      <table className="tnum w-full min-w-[400px] border-collapse text-right text-sm">
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-3 text-left font-semibold">Year</th>
            <th
              className="cursor-help px-3 py-2 font-semibold"
              title="Mortgage + property tax + maintenance + insurance + PMI/HOA, less the tax benefit."
            >
              Cost to own
            </th>
            <th className="px-3 py-2 font-semibold">Rent</th>
            <th className="px-3 py-2 font-semibold">Your equity</th>
            <th className="w-7" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const isOpen = open.has(y.year);
            return (
              <Fragment key={y.year}>
                <tr
                  onClick={() => toggle(y.year)}
                  className="group cursor-pointer border-b border-line/60 last:border-0 hover:bg-paper"
                >
                  <td className="py-2 pr-3 text-left font-semibold">{y.year}</td>
                  <td className="px-3 py-2 text-ink">{usd(netOwningCost(y))}</td>
                  <td className="px-3 py-2 text-muted">{usd(y.rentPaid)}</td>
                  <td className="px-3 py-2 text-rent-text">{usd(y.equity)}</td>
                  <td className="pr-1 text-right">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`Year ${y.year} breakdown`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(y.year);
                      }}
                      className="text-muted transition-colors hover:text-ink"
                    >
                      <Chevron open={isOpen} />
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-line/60 bg-surface/60">
                    <td colSpan={5} className="px-3 py-3 text-left">
                      <Detail y={y} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
