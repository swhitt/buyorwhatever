import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLiveMarket } from "./live";

// A fully-populated, valid market payload.
const good = {
  asOf: "2026-06-12",
  mortgage: { rate30: 0.065, rate15: 0.058, asOf: "2026-06-11", source: "Freddie Mac" },
  inflation: { rate: 0.04, asOf: "2026-05", source: "BLS" },
  appreciation: { rate1yr: 0.03, rate5yrCagr: 0.04, asOf: "2026-04", source: "Zillow" },
  national: { homeValue: 368000, rent: 1930, asOf: "2026-04", source: "Zillow" },
};

const mockFetch = (impl: (...args: unknown[]) => Promise<unknown>) => vi.stubGlobal("fetch", vi.fn(impl));

afterEach(() => vi.unstubAllGlobals());

describe("fetchLiveMarket", () => {
  it("returns a fully-valid payload", async () => {
    mockFetch(async () => ({ ok: true, json: async () => good }));
    expect(await fetchLiveMarket()).toEqual(good);
  });

  it("rejects a payload missing a numeric field the app reads (inflation.rate)", async () => {
    const bad = { ...good, inflation: { asOf: "2026-05", source: "BLS" } };
    mockFetch(async () => ({ ok: true, json: async () => bad }));
    expect(await fetchLiveMarket()).toBeNull();
  });

  it("rejects a non-finite number where one is required (rate15: null)", async () => {
    const bad = { ...good, mortgage: { ...good.mortgage, rate15: null } };
    mockFetch(async () => ({ ok: true, json: async () => bad }));
    expect(await fetchLiveMarket()).toBeNull();
  });

  it("rejects a payload missing the appreciation block the panels read", async () => {
    const { appreciation: _drop, ...bad } = good;
    mockFetch(async () => ({ ok: true, json: async () => bad }));
    expect(await fetchLiveMarket()).toBeNull();
  });

  it("rejects a payload missing an as-of date the panels render", async () => {
    const bad = { ...good, national: { ...good.national, asOf: undefined } };
    mockFetch(async () => ({ ok: true, json: async () => bad }));
    expect(await fetchLiveMarket()).toBeNull();
  });

  it("returns null on a non-ok HTTP response", async () => {
    mockFetch(async () => ({ ok: false, json: async () => good }));
    expect(await fetchLiveMarket()).toBeNull();
  });

  it("returns null when the fetch rejects (offline/blocked/timeout)", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchLiveMarket()).toBeNull();
  });
});
