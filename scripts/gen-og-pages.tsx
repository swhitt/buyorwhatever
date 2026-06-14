// Postbuild: for every metro, render a per-scenario Open Graph PNG (the real engine
// verdict + numbers) and a prerendered HTML page with metro-specific meta, both into
// dist/. So a shared breakeven.rent/houston-tx link unfurls with Houston's card and
// Google sees 401 distinct pages. @vercel/og runs fine here (full Node at build time),
// unlike a plain-Vite serverless function. Runs after `vite build`.
import { ImageResponse } from "@vercel/og";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { calculate } from "../src/engine/calculator";
import { buildInputs } from "../src/engine/defaults";
import { usd } from "../src/lib/format";
import type { LocationData } from "../src/data/types";
import { insurance, locations, market, propertyTax } from "../src/data/rates";

const SITE = "https://breakeven.rent";
const INK = "#1a1a16";
const MUTED = "#6b6a61";
const PAPER = "#faf9f5";
const RENT = "#0d9488";
const BUY = "#ea580c";
const TITLE_DEFAULT = "Breakeven: rent vs. buy, with the math shown";
const DESC_DEFAULT =
  "Rent-vs-buy with live mortgage rates, rents, and home prices, and a year-by-year breakdown of the math.";

const dist = new URL("../dist/", import.meta.url);
mkdirSync(new URL("og/", dist), { recursive: true });
const template = readFileSync(new URL("index.html", dist), "utf8");

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $.,/%?()'-:&";
async function loadInter(weight: number): Promise<ArrayBuffer> {
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@${weight}&text=${encodeURIComponent(CHARS)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 6.1)" },
    })
  ).text();
  const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!url) throw new Error("Inter TTF not found in Google CSS");
  return await (await fetch(url)).arrayBuffer();
}
const [regular, bold] = await Promise.all([loadInter(400), loadInter(800)]);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

interface Card {
  metro: string;
  word: string;
  color: string;
  takeaway: string;
  breakeven: string;
  homePrice: string;
  rent: string;
}

function cardFor(loc: LocationData): Card {
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

async function renderPng(d: Card): Promise<Buffer> {
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
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800, color: INK }}>{d.metro}?</div>
          <div style={{ display: "flex", fontSize: 92, fontWeight: 800, color: d.color, marginTop: 12 }}>{d.word}</div>
          <div style={{ display: "flex", fontSize: 34, color: INK, marginTop: 8, maxWidth: 1000 }}>{d.takeaway}</div>
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
  return Buffer.from(await image.arrayBuffer());
}

function pageFor(id: string, d: Card): string {
  const sub = d.word === "Toss-up" ? "too close to call" : d.word === "Rent" ? "renting wins" : "buying wins";
  const title = `Rent vs. buy in ${d.metro}: ${sub}`;
  const desc = `${d.takeaway} ${d.homePrice} home, live data, the math shown.`;
  return template
    .replaceAll(`${SITE}/og.png`, `${SITE}/og/${id}.png`)
    .replaceAll(`"${SITE}/"`, `"${SITE}/${id}"`)
    .replaceAll(TITLE_DEFAULT, esc(title))
    .replaceAll(DESC_DEFAULT, esc(desc));
}

// A per-ZIP page so /<zip> resolves to a real static file (200, like the metro pages, since
// Vercel's cleanUrls serves them and the SPA catch-all rewrite does not fire for misses) and
// unfurls with that ZIP's own verdict in the title/description. noindex keeps these ~8k thin
// pages out of search; they exist for routing and link sharing, not SEO. The card image is the
// generic one for now (per-ZIP card images are a Blob job, see the OG backlog).
// Manifest of ZIP -> Blob OG image URL, written by render-zip-og for the top-N ZIPs. The long
// tail (and any run before the manifest exists) falls back to the generic card.
const zipOg: Record<string, string> = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../src/data/zipOg.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
})();

function zipPageFor(zip: string, d: Card): string {
  const sub = d.word === "Toss-up" ? "too close to call" : d.word === "Rent" ? "renting wins" : "buying wins";
  const title = `Rent vs. buy in ${d.metro} (ZIP ${zip}): ${sub}`;
  const desc = `${d.takeaway} ${d.homePrice} home, live data, the math shown.`;
  const ogImage = zipOg[zip];
  let html = template
    .replace("</head>", '<meta name="robots" content="noindex" />\n  </head>')
    .replaceAll(`"${SITE}/"`, `"${SITE}/${zip}"`)
    .replaceAll(TITLE_DEFAULT, esc(title))
    .replaceAll(DESC_DEFAULT, esc(desc));
  if (ogImage) html = html.replaceAll(`${SITE}/og.png`, esc(ogImage));
  return html;
}

let n = 0;
for (const loc of locations) {
  if (loc.id === "united-states") continue; // the root page already covers the national view
  const d = cardFor(loc);
  writeFileSync(new URL(`og/${loc.id}.png`, dist), await renderPng(d));
  writeFileSync(new URL(`${loc.id}.html`, dist), pageFor(loc.id, d));
  n++;
}

// Per-ZIP pages: one static shell per ZIP in zips.json, so /<zip> resolves and unfurls with
// the ZIP's own numbers. Cheap (HTML + one engine run each, no PNG render), so all ~8k get a
// page; the OG card image is the on-demand endpoint's job, not baked here.
interface RawZip {
  h: number;
  r: number;
  s: string;
  c: string;
}
const zips = JSON.parse(readFileSync(new URL("../public/zips.json", import.meta.url), "utf8")) as Record<
  string,
  RawZip
>;
let zn = 0;
for (const [zip, z] of Object.entries(zips)) {
  const loc: LocationData = { id: `zip-${zip}`, metro: `${z.c}, ${z.s}`, state: z.s, homeValue: z.h, rent: z.r };
  writeFileSync(new URL(`${zip}.html`, dist), zipPageFor(zip, cardFor(loc)));
  zn++;
}

// /calc is client-routed too, so cleanUrls needs a calc.html shell (otherwise the clean
// URL 404s before the SPA rewrite). Give it its own title; the generic OG image is fine.
const calcHtml = template
  .replaceAll(TITLE_DEFAULT, "Should you rent or buy? The quick answer, in four numbers")
  .replaceAll(`"${SITE}/"`, `"${SITE}/calc"`);
writeFileSync(new URL("calc.html", dist), calcHtml);

// A sitemap of the indexable pages (root, the /calc quick mode, and every metro page) so
// crawlers can actually reach the prerendered metro pages, which are otherwise reachable
// only through JS-driven navigation. The ~8k noindex ZIP pages are deliberately left out.
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sitemapUrls = [
  `${SITE}/`,
  `${SITE}/calc`,
  ...locations.filter((l) => l.id !== "united-states").map((l) => `${SITE}/${l.id}`),
];
const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  sitemapUrls.map((u) => `  <url><loc>${xmlEscape(u)}</loc><lastmod>${market.asOf}</lastmod></url>`).join("\n") +
  "\n</urlset>\n";
writeFileSync(new URL("sitemap.xml", dist), sitemap);

console.log(
  `gen-og-pages: wrote ${n} metro pages + OG cards, ${zn} ZIP pages, calc.html, sitemap.xml (${sitemapUrls.length} urls) to dist/`,
);
