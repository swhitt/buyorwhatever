import { useEffect, useId, useState, type ReactNode } from "react";

/**
 * Field label + optional hint/live-data badge, wrapping any control. Defaults to a
 * <label> (one control per field). Pass `group` when the body holds several
 * controls (each with its own label): it renders a labelled group instead, so we
 * never nest <label> elements, which breaks accessible-name association.
 */
export function Field({
  label,
  hint,
  info,
  badge,
  children,
  group = false,
}: {
  label: string;
  // Shown below the control, always visible. Reserve for live/derived values ("$X down") and
  // interactive "use it" actions, NOT prose, or the panel turns into a wall of text.
  hint?: ReactNode;
  // On-demand explanation, surfaced via an InfoTip "i" next to the label. This is where teaching
  // prose belongs so it stays reachable without crowding the form.
  info?: string;
  badge?: ReactNode;
  children: ReactNode;
  group?: boolean;
}) {
  const id = useId();
  const hintId = useId();
  const labelRow = (
    <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
      <span className="inline-flex items-center whitespace-nowrap text-sm font-medium text-ink">
        {/* id wraps just the label text so an InfoTip "i" never pollutes the group's name. */}
        <span id={group ? id : undefined}>{label}</span>
        {info && <InfoTip text={info} />}
      </span>
      {badge}
    </div>
  );
  const hintEl = hint ? (
    <p id={hintId} className="mt-1 text-xs text-muted">
      {hint}
    </p>
  ) : null;
  // A <label> wrapping the control gives implicit name association, but it can't contain an
  // interactive element: the InfoTip button (info) or several controls (group) would both be
  // invalid nested in a <label>, and a stray click would toggle the label's input. In those
  // cases render a header div instead; the control carries its own name (Slider/MoneyInput take
  // an explicit label/ariaLabel). The hint also stays outside the <label> for the same reason
  // (it can hold a "use it" button).
  return group || info ? (
    <div role={group ? "group" : undefined} aria-labelledby={group ? id : undefined}>
      {labelRow}
      {children}
      {hintEl}
    </div>
  ) : (
    <>
      <label className="block">
        {labelRow}
        {children}
      </label>
      {hintEl}
    </>
  );
}

/**
 * A small "i" affordance that reveals an explanation. A real focusable <button> with the
 * text mirrored into aria-label, so it's reachable by keyboard and screen readers (unlike a
 * bare title=); the visual bubble appears on hover AND focus, and on tap (focus) for touch.
 * The bubble drops downward so it isn't clipped by a horizontally-scrolling container.
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="group/tip relative ml-1 inline-flex align-middle">
      <button
        type="button"
        aria-label={text}
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current text-[9px] font-bold leading-none text-muted transition-colors hover:text-ink focus-visible:text-ink"
      >
        i
      </button>
      <span
        aria-hidden="true"
        // whitespace-normal/break-words are explicit because a label wrapper may set
        // whitespace-nowrap, which would otherwise make the bubble one long line that
        // ignores its width and bleeds across the layout.
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-56 max-w-[60vw] -translate-x-1/2 whitespace-normal break-words rounded-lg border border-line bg-surface px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-muted opacity-0 shadow-lg transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

/** Small pill that cites a live data value next to an input. */
export function LiveBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-rent-soft px-2 py-0.5 text-[11px] font-medium text-rent-text">
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
  max = 1e12,
  placeholder,
  ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  max?: number;
  placeholder?: string;
  // Needed when the input isn't the lone child of a <label> (e.g. CostRow's group-mode field).
  ariaLabel?: string;
}) {
  // Show 0 as an empty field (with a placeholder) rather than a literal "0", which reads as a
  // real entry, e.g. an income of $0.
  const [text, setText] = useState(() => (value ? value.toLocaleString("en-US") : ""));

  // Sync with external changes (location switch, reset) without disrupting
  // typing: only rewrite when the shown number actually diverges from `value`.
  // During typing the two stay equal, so this never fights the cursor.
  useEffect(() => {
    const shown = Number(text.replace(/[^0-9]/g, ""));
    if (shown !== value) setText(value ? value.toLocaleString("en-US") : "");
  }, [value, text]);

  // Clamp to [0, max] so an extreme paste can't overflow the engine to NaN.
  const commit = (n: number) => {
    const clamped = Math.max(0, Math.min(n, max));
    setText(clamped ? clamped.toLocaleString("en-US") : "");
    onChange(clamped);
  };

  return (
    <div className="flex items-center rounded-lg border border-line bg-surface focus-within:border-ink focus-within:ring-2 focus-within:ring-ink/10">
      <span className="pl-3 pr-1 text-muted">$</span>
      <input
        inputMode="numeric"
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="tnum w-full bg-transparent py-2.5 pr-3 text-[15px] font-medium outline-none placeholder:font-normal placeholder:text-muted/60"
        value={text}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9]/g, "");
          if (raw === "") {
            setText("");
            onChange(0);
            return;
          }
          commit(Number(raw));
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const cur = Number(text.replace(/[^0-9]/g, "")) || 0;
          commit(cur + (e.key === "ArrowUp" ? step : -step));
        }}
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
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  format: (n: number) => string;
  // An explicit accessible name, needed when the slider isn't the lone child of a <label>
  // (group-mode fields, and CostRow where a Segmented + range share one field).
  label?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        className="min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="tnum w-16 shrink-0 text-right text-sm font-semibold text-ink">{format(value)}</span>
    </div>
  );
}

/** Segmented control for small, mutually exclusive choices. Uses the toggle-button pattern
 *  (aria-pressed per option) so the active choice is exposed to assistive tech, not signalled
 *  by background color alone. `ariaLabel` names the group for screen readers. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
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
