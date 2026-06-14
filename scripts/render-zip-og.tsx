// Renders an Open Graph card for the top-N ZIPs (by Zillow market-size rank) and uploads each
// to Vercel Blob, then writes src/data/zipOg.json mapping zip -> Blob URL. gen-og-pages reads
// that manifest and points those ZIP pages' og:image at the static Blob image; the long tail
// keeps the generic card. Runs in FULL NODE (where @vercel/og works, unlike the serverless
// runtime that crashes on its wasm), during the weekly data refresh.
//
// Run: BLOB_READ_WRITE_TOKEN=... vite-node scripts/render-zip-og.tsx   (token also read from .env.local)
import { ImageResponse } from "@vercel/og";
import { put } from "@vercel/blob";
import { readFileSync, writeFileSync } from "node:fs";
import { calculate } from "../src/engine/calculator";
import { buildInputs } from "../src/engine/defaults";
import { usd } from "../src/lib/format";
import type { LocationData } from "../src/data/types";
import { insurance, market, propertyTax } from "../src/data/rates";

const TOP_N = Number(process.env.ZIP_OG_TOP_N ?? 200);
const INK = "#1a1a16";
const MUTED = "#6b6a61";
const PAPER = "#faf9f5";
const RENT = "#0d9488";
const BUY = "#ea580c";

const token =
  process.env.BLOB_READ_WRITE_TOKEN ??
  (() => {
    try {
      return readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(
        /BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/,
      )?.[1];
    } catch {
      return undefined;
    }
  })();
if (!token) throw new Error("BLOB_READ_WRITE_TOKEN not set (env or .env.local)");

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $.,/%?()'-:&";
async function loadInter(weight: number): Promise<ArrayBuffer> {
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@${weight}&text=${encodeURIComponent(CHARS)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 6.1)" },
    })
  ).text();
  const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!url) throw new Error("Inter TTF not found");
  return await (await fetch(url)).arrayBuffer();
}
const [regular, bold] = await Promise.all([loadInter(400), loadInter(800)]);

interface RawZip {
  h: number;
  r: number;
  s: string;
  c: string;
  k: number;
}
const zips = JSON.parse(readFileSync(new URL("../public/zips.json", import.meta.url), "utf8")) as Record<
  string,
  RawZip
>;

interface Card {
  metro: string;
  word: string;
  color: string;
  takeaway: string;
  breakeven: string;
  homePrice: string;
  rent: string;
}
function cardFor(zip: string, z: RawZip): Card {
  const loc: LocationData = { id: `zip-${zip}`, metro: `${z.c}, ${z.s}`, state: z.s, homeValue: z.h, rent: z.r };
  const inputs = buildInputs(loc, market, propertyTax, insurance);
  const r = calculate(inputs);
  const closeCall = Math.abs(r.monthlyDifference) < inputs.monthlyRent * 0.05;
  const renting = r.verdict === "rent";
  const breakeven = `${usd(r.breakevenRent)}/mo`;
  const rentStr = `${usd(inputs.monthlyRent)}/mo`;
  return {
    metro: loc.metro,
    word: closeCall ? "Toss-up" : renting ? "Rent" : "Buy",
    color: closeCall ? INK : renting ? RENT : BUY,
    takeaway: closeCall
      ? `Rent and buy break even near ${breakeven}, so your ${rentStr} is basically a coin flip.`
      : `Rent and buy break even at a rent of ${breakeven}. At ${rentStr}, ${renting ? "renting" : "buying"} wins.`,
    breakeven,
    homePrice: usd(inputs.homePrice),
    rent: rentStr,
  };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", fontSize: 24, color: MUTED, textTransform: "uppercase" }}>{label}</div>
      <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: INK }}>{value}</div>
    </div>
  );
}

async function renderPng(zip: string, d: Card): Promise<Buffer> {
  const image = new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: PAPER,
          padding: 72,
          justifyContent: "space-between",
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 800 }}>
            <span style={{ color: RENT }}>break</span>
            <span style={{ color: BUY }}>Even</span>
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED }}>rent vs. buy, with the math shown</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 32, color: MUTED }}>Should you rent or buy in</div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 800, color: INK }}>
            {d.metro} ({zip})?
          </div>
          <div style={{ display: "flex", fontSize: 92, fontWeight: 800, color: d.color, marginTop: 12 }}>{d.word}</div>
          <div style={{ display: "flex", fontSize: 34, color: INK, marginTop: 8, maxWidth: 1040 }}>{d.takeaway}</div>
        </div>
        <div style={{ display: "flex", gap: 64 }}>
          <Stat label="Breakeven rent" value={d.breakeven} />
          <Stat label="Home price" value={d.homePrice} />
          <Stat label="Comparable rent" value={d.rent} />
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Inter", data: regular, weight: 400, style: "normal" },
        { name: "Inter", data: bold, weight: 800, style: "normal" },
      ],
    },
  );
  // ~70KB flat-color PNG, fine for an OG card at top-N scale. We skip palette compression to
  // avoid a second libvips (@vercel/og bundles its own), which warns about "mysterious crashes".
  return Buffer.from(await image.arrayBuffer());
}

const top = Object.entries(zips)
  .sort((a, b) => a[1].k - b[1].k)
  .slice(0, TOP_N);

const manifest: Record<string, string> = {};
let i = 0;
for (const [zip, z] of top) {
  const png = await renderPng(zip, cardFor(zip, z));
  const blob = await put(`zip-og/${zip}.png`, png, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
    cacheControlMaxAge: 31536000,
    token,
    allowOverwrite: true,
  });
  manifest[zip] = blob.url;
  if (++i % 25 === 0) console.log(`  ${i}/${top.length}`);
}

// Sort keys for clean diffs.
const sorted: Record<string, string> = {};
for (const k of Object.keys(manifest).sort()) sorted[k] = manifest[k];
writeFileSync(new URL("../src/data/zipOg.json", import.meta.url), JSON.stringify(sorted, null, 0) + "\n");
console.log(`render-zip-og: rendered + uploaded ${top.length} ZIP cards to Blob, wrote manifest`);
