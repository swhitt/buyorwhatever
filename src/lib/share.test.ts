import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare } from "./share";

const payload = {
  m: "new-york-ny",
  o: { homePrice: 850000, downPaymentPct: 0.15, taxState: "NY", taxAuto: true, maintenanceMode: "amount" },
};

describe("share encode/decode", () => {
  it("round-trips a payload through a url-safe token", () => {
    const token = encodeShare(payload);
    expect(token).not.toMatch(/[+/=\s]/); // url-safe, no padding or whitespace
    expect(decodeShare(token)).toEqual(payload);
  });

  it("is deterministic (same payload -> same token)", () => {
    expect(encodeShare(payload)).toBe(encodeShare(payload));
  });

  it("round-trips non-Latin1 strings without loss (UTF-8 safe)", () => {
    const p = { m: "münchen-café-✈", o: { taxState: "NY" } };
    expect(decodeShare(encodeShare(p))).toEqual(p);
  });

  it("round-trips floating-point values exactly", () => {
    const p = { o: { downPaymentPct: 0.15, investmentReturn: 0.0425, mortgageRate: 0.06375 } };
    const out = decodeShare(encodeShare(p));
    expect(out?.o).toEqual(p.o);
  });

  it("defaults a missing overrides object to empty", () => {
    expect(decodeShare(encodeShare({ m: "united-states" }))).toEqual({ m: "united-states", o: {} });
  });

  it("rejects a token corrupted in transit instead of applying wrong values", () => {
    const token = encodeShare(payload);
    // Flip a character in the body: a partial corruption can stay valid JSON, so
    // the checksum is what catches it.
    const flipChar = (s: string, i: number) => s.slice(0, i) + (s[i] === "a" ? "b" : "a") + s.slice(i + 1);
    expect(decodeShare(flipChar(token, 5))).toBeNull();
    expect(decodeShare(token.slice(0, token.length - 3))).toBeNull(); // truncated
    expect(decodeShare(token + "x")).toBeNull(); // appended
  });

  it("returns null on garbage, empty, or unseparated input", () => {
    expect(decodeShare("not a real token !!!")).toBeNull();
    expect(decodeShare("")).toBeNull();
    expect(decodeShare("no-separator-here")).toBeNull();
  });

  it("does not leave field names in plain text (rot13 obfuscation)", () => {
    const body = encodeShare({ m: "x", o: { homePrice: 1 } }).split("~")[0];
    expect(atob(body.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("homePrice");
  });
});
