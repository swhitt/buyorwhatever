import { useEffect, useMemo, useRef, useState } from "react";
import type { LocationData } from "../data/types";
import { usd } from "../lib/format";

export function LocationPicker({
  locations,
  selected,
  onSelect,
}: {
  locations: LocationData[];
  selected: LocationData;
  onSelect: (loc: LocationData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return locations.slice(0, 60);
    return locations.filter((l) => l.metro.toLowerCase().includes(q)).slice(0, 60);
  }, [locations, query]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function choose(loc: LocationData) {
    onSelect(loc);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
        className="flex w-full items-center justify-between rounded-lg border border-line bg-surface px-3 py-2.5 text-left hover:border-ink/40"
      >
        <span className="flex items-center gap-2">
          <svg className="h-4 w-4 text-rent" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M10 2a6 6 0 00-6 6c0 4 6 10 6 10s6-6 6-10a6 6 0 00-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z"
              clipRule="evenodd"
            />
          </svg>
          <span className="font-semibold">{selected.metro}</span>
        </span>
        <svg className="h-4 w-4 text-muted" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/10">
          <input
            autoFocus
            placeholder="Search 400+ metros..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
              if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
              if (e.key === "Enter" && results[active]) choose(results[active]);
              if (e.key === "Escape") setOpen(false);
            }}
            className="w-full border-b border-line px-3 py-2.5 text-sm outline-none"
          />
          <ul className="max-h-72 overflow-y-auto py-1">
            {results.map((loc, i) => (
              <li key={loc.id}>
                <button
                  type="button"
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
            {results.length === 0 && <li className="px-3 py-3 text-sm text-muted">No metros match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
