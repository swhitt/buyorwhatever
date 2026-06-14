import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { LocationData } from "../data/types";
import { usd } from "../lib/format";
import { lookupZip, type ZipData } from "../lib/zips";

export interface ActiveZip {
  zip: string;
  city: string;
  state: string;
  homeValue: number; // the ZIP's own Zillow figures, so the field badges reference them
  rent: number;
}

export function LocationPicker({
  locations,
  selected,
  activeZip,
  onSelect,
  onSelectZip,
}: {
  locations: LocationData[];
  selected: LocationData;
  activeZip: ActiveZip | null;
  onSelect: (loc: LocationData) => void;
  onSelectZip: (zip: string, data: ZipData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // When the query is a complete 5-digit ZIP we look it up live and offer it as a
  // selectable result, so the one search box covers metros and ZIPs both.
  const [zipHit, setZipHit] = useState<{ zip: string; data: ZipData | null; loading: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return locations.slice(0, 60);
    return locations.filter((l) => l.metro.toLowerCase().includes(q)).slice(0, 60);
  }, [locations, query]);

  // Resolve a 5-digit query against the lazy zip table (cancelling stale lookups).
  useEffect(() => {
    const q = query.trim();
    if (!/^\d{5}$/.test(q)) {
      setZipHit(null);
      return;
    }
    let cancelled = false;
    setZipHit({ zip: q, data: null, loading: true });
    lookupZip(q)
      .then((data) => {
        if (!cancelled) setZipHit({ zip: q, data, loading: false });
      })
      .catch(() => {
        if (!cancelled) setZipHit({ zip: q, data: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Keep the highlighted option visible as the user arrows through the list.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function reset() {
    setOpen(false);
    setQuery("");
    setZipHit(null);
    triggerRef.current?.focus();
  }

  function choose(loc: LocationData) {
    onSelect(loc);
    reset();
  }

  function chooseZip(zip: string, data: ZipData) {
    onSelectZip(zip, data);
    reset();
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  const triggerLabel = activeZip ? `${activeZip.city}, ${activeZip.state}` : selected.metro;

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          activeZip
            ? `Change location, currently ZIP ${activeZip.zip} in ${activeZip.city}, ${activeZip.state}`
            : `Change metro, currently ${selected.metro}`
        }
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
        className="flex w-full items-center justify-between rounded-lg border border-line bg-surface px-3 py-2.5 text-left hover:border-ink/40"
      >
        <span className="flex min-w-0 items-center gap-2">
          <svg className="h-4 w-4 shrink-0 text-rent" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M10 2a6 6 0 00-6 6c0 4 6 10 6 10s6-6 6-10a6 6 0 00-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z"
              clipRule="evenodd"
            />
          </svg>
          <span className="truncate font-semibold">{triggerLabel}</span>
          {activeZip && (
            <span className="shrink-0 rounded bg-paper px-1.5 py-0.5 text-xs font-medium text-muted">
              ZIP {activeZip.zip}
            </span>
          )}
        </span>
        <svg
          className="h-4 w-4 shrink-0 text-muted"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/10">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label="Search metros or enter a ZIP"
            aria-activedescendant={!zipHit && results[active] ? `${listId}-opt-${active}` : undefined}
            placeholder="Search a metro or type a ZIP"
            value={query}
            inputMode="text"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // A resolved ZIP wins; otherwise pick the highlighted metro.
                if (zipHit?.data) chooseZip(zipHit.zip, zipHit.data);
                else if (results[active]) choose(results[active]);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Home") {
                e.preventDefault();
                setActive(0);
              } else if (e.key === "End") {
                e.preventDefault();
                setActive(results.length - 1);
              } else if (e.key === "Escape") {
                close();
              }
            }}
            className="w-full border-b border-line px-3 py-2.5 text-sm outline-none"
          />

          {/* A complete ZIP shows its own result above the metro list. */}
          {zipHit && (
            <div className="border-b border-line">
              <div className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">By ZIP</div>
              {zipHit.loading ? (
                <div className="flex items-center justify-between px-3 py-2 text-sm text-muted">
                  <span>ZIP {zipHit.zip}</span>
                  <span>Looking up…</span>
                </div>
              ) : zipHit.data ? (
                <button
                  type="button"
                  onClick={() => chooseZip(zipHit.zip, zipHit.data!)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-paper"
                >
                  <span className="font-medium">
                    ZIP {zipHit.zip} · {zipHit.data.city}, {zipHit.data.state}
                  </span>
                  <span className="tnum text-xs text-muted">
                    {usd(zipHit.data.homeValue)} · {usd(zipHit.data.rent)}/mo
                  </span>
                </button>
              ) : (
                <div className="flex items-center justify-between px-3 py-2 text-sm text-muted">
                  <span>ZIP {zipHit.zip}</span>
                  <span>No data, try a metro</span>
                </div>
              )}
            </div>
          )}

          <ul id={listId} role="listbox" aria-label="Metros" className="max-h-72 overflow-y-auto py-1">
            {results.map((loc, i) => (
              <li key={loc.id} role="option" aria-selected={i === active}>
                <button
                  ref={i === active ? activeRef : undefined}
                  id={`${listId}-opt-${i}`}
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(loc)}
                  className={
                    "flex w-full items-center justify-between px-3 py-2 text-left text-sm " +
                    (i === active ? "bg-paper" : "")
                  }
                >
                  <span className="font-medium">{loc.metro}</span>
                  <span className="tnum text-xs text-muted">
                    {usd(loc.homeValue)} · {usd(loc.rent)}/mo
                  </span>
                </button>
              </li>
            ))}
            {results.length === 0 && !zipHit && <li className="px-3 py-3 text-sm text-muted">No metros match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
