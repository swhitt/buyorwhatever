import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Field label + optional hint/live-data badge, wrapping any control. */
export function Field({
  label,
  hint,
  badge,
  children,
}: {
  label: string;
  hint?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        {badge}
      </div>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </label>
  );
}

/** Small pill that cites a live data value next to an input. */
export function LiveBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rent-soft px-2 py-0.5 text-[11px] font-medium text-rent">
      <span className="h-1.5 w-1.5 rounded-full bg-rent" />
      {children}
    </span>
  );
}

/** Dollar input with a $ prefix and thousands formatting while typing. */
export function MoneyInput({
  value,
  onChange,
  step = 1000,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
}) {
  const [text, setText] = useState(value.toLocaleString("en-US"));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value.toLocaleString("en-US"));
  }, [value]);

  return (
    <div className="flex items-center rounded-lg border border-line bg-surface focus-within:border-ink focus-within:ring-2 focus-within:ring-ink/10">
      <span className="pl-3 pr-1 text-muted">$</span>
      <input
        inputMode="numeric"
        className="tnum w-full bg-transparent py-2.5 pr-3 text-[15px] font-medium outline-none"
        value={text}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          setText(value.toLocaleString("en-US"));
        }}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, "");
          setText(raw === "" ? "" : Number(raw).toLocaleString("en-US"));
          onChange(raw === "" ? 0 : Number(raw));
        }}
        aria-label="dollar amount"
        data-step={step}
      />
    </div>
  );
}

/** Labeled range slider with a formatted live value on the right. */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  format: (n: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        className="flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="tnum w-16 shrink-0 text-right text-sm font-semibold text-ink">{format(value)}</span>
    </div>
  );
}

/** Segmented control for small, mutually exclusive choices. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
            (o.value === value ? "bg-ink text-paper" : "text-muted hover:text-ink")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Disclosure with a chevron, used for the advanced-assumptions panel. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold"
      >
        {summary}
        <svg
          className={"h-4 w-4 text-muted transition-transform " + (open ? "rotate-180" : "")}
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={id} className="border-t border-line px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}
