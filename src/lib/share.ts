// Encodes a shareable view into a single URL-safe token: base64url(utf8(rot13(JSON)))
// with a checksum suffix. rot13 is light obfuscation so the raw JSON isn't sitting
// in plain sight (it is NOT security). The codec is deterministic and non-lossy:
//   - UTF-8 round-trips any string (btoa alone throws on non-Latin1).
//   - base64 padding is re-derived on decode, never guessed.
//   - a djb2 checksum of the plaintext is appended; decode recomputes it and
//     returns null on any mismatch, so a token corrupted in transit is rejected
//     outright instead of silently applying a wrong (but still-parseable) scenario.
// The payload carries only what the user changed from the location's defaults, plus
// the metro id, so links stay short and re-derive everything else from live data.

export interface SharePayload {
  m?: string; // metro id (location)
  o?: Record<string, unknown>; // overrides: fields that differ from the defaults
}

const SEP = "~"; // RFC 3986 unreserved, so it needs no URL-encoding

const rot13 = (s: string) =>
  s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });

// Deterministic djb2 hash -> base36, for detecting accidental corruption.
const checksum = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

function utf8ToBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToUtf8(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeShare(payload: SharePayload): string {
  const json = JSON.stringify(payload);
  return `${utf8ToBase64Url(rot13(json))}${SEP}${checksum(json)}`;
}

export function decodeShare(token: string): SharePayload | null {
  try {
    const sep = token.lastIndexOf(SEP);
    if (sep < 0) return null;
    const json = rot13(base64UrlToUtf8(token.slice(0, sep)));
    if (checksum(json) !== token.slice(sep + 1)) return null; // corrupted in transit
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as SharePayload;
    const m = typeof p.m === "string" ? p.m : undefined;
    const o = p.o && typeof p.o === "object" ? (p.o as Record<string, unknown>) : {};
    return { m, o };
  } catch {
    return null;
  }
}
