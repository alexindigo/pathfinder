// Public dashboard generator: regenerates docs/dashboard.html from the
// bench-results.json snapshot. Zero-dependency inline SVG,
// generator-not-server. Data collection lives in our internal benchmark
// lab; this script only renders the snapshot into the public page.

const IN_FILE = "bench/bench-results.json";
const OUT_FILE = "docs/dashboard.html";

interface BenchRow {
  label: string;
  routeSetSize: number;
  pathShape: string;
  matcher: string;
  opsPerSec: number;
  medianNs: number;
  p95Ns: number;
  p99Ns: number;
  constructionMs: number;
}

const SM_COLOR = "#7c6cf0";
const RE_COLOR = "#0fb894";
const COM_COLOR = "#e0862e";
const SM_NAME = "State machine (SM)";
const RE_NAME = "Regex (RE)";
const COM_NAME = "Compiled (automaton)";

const MATCHERS = [
  { key: "state-machine", label: "SM", name: SM_NAME, color: SM_COLOR },
  { key: "regex", label: "RE", name: RE_NAME, color: RE_COLOR },
  { key: "compiled", label: "COM", name: COM_NAME, color: COM_COLOR },
] as const;

// Constants updated from the fresh correctness/bench runs of 2026-08-28.
const PARITY = {
  routes: 228,
  paths: 1945,
  mismatches: 0,
  asOf: "2026-08-28",
};
const FLATNESS = {
  ratio: "1.04",
  hits: 284,
  median10: 1256,
  medianFull: 1300,
  full: 228,
};

const SHAPES_FOR_FULL = [
  "real-matrix",
  "random-matrix",
  "adversarial",
  "long-input",
];

function fail(msg: string): never {
  console.error(`dashboard: ${msg}`);
  Deno.exit(1);
}

function loadRows(): BenchRow[] {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(IN_FILE);
  } catch {
    return fail(`cannot read ${IN_FILE}. Run "deno task bench" first.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail(
      `${IN_FILE} is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return fail(`${IN_FILE} contains no rows.`);
  }
  const first = parsed[0] as Record<string, unknown>;
  const required = [
    "routeSetSize",
    "pathShape",
    "matcher",
    "opsPerSec",
    "medianNs",
    "p95Ns",
    "p99Ns",
    "constructionMs",
  ];
  for (const key of required) {
    if (
      typeof first[key] !== "number" && key !== "pathShape" && key !== "matcher"
    ) {
      return fail(
        `${IN_FILE} rows are missing the "${key}" field — was it produced by a different bench.ts?`,
      );
    }
  }
  return parsed as BenchRow[];
}

const rows = loadRows();

const sizes = [...new Set(rows.map((r) => r.routeSetSize))].sort((a, b) =>
  a - b
);
const FULL = sizes[sizes.length - 1];

function pick(
  size: number,
  shape: string,
  matcher: string,
): BenchRow | undefined {
  return rows.find((r) =>
    r.routeSetSize === size && r.pathShape === shape && r.matcher === matcher
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUs(ns: number): string {
  return ns >= 1000 ? `${(ns / 1000).toFixed(2)} µs` : `${Math.round(ns)} ns`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function niceLogTicks(min: number, max: number): number[] {
  const ticks: number[] = [];
  const kMin = Math.floor(Math.log10(min));
  const kMax = Math.ceil(Math.log10(max));
  for (let k = kMin; k <= kMax; k++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** k;
      if (v >= min && v <= max) ticks.push(v);
    }
  }
  return ticks;
}

function niceLinTicks(min: number, max: number, target = 5): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const step = 10 ** Math.floor(Math.log10(span / target));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * step);
  const chosen = candidates.find((c) => span / c <= target * 1.4) ??
    candidates[candidates.length - 1];
  const out: number[] = [];
  for (let v = Math.ceil(min / chosen) * chosen; v <= max + 1e-9; v += chosen) {
    out.push(v);
  }
  return out;
}

function legend(): string {
  return `<div class="legend">
    ${
    MATCHERS.map((m) =>
      `<span class="chip"><span class="swatch" style="background:${m.color}"></span>${m.name}</span>`
    ).join("\n    ")
  }
  </div>`;
}

function groupedBars(
  groups: {
    name: string;
    bars: { value: number; color: string; tip: string }[];
  }[],
): string {
  const W = 760, H = 300, padL = 62, padR = 10, padT = 12, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = groups.flatMap((g) => g.bars.map((b) => b.value));
  const lo = Math.min(...vals) * 0.8, hi = Math.max(...vals) * 1.3;
  const llo = Math.log10(lo), lhi = Math.log10(hi);
  const y = (v: number) =>
    padT + plotH * (1 - (Math.log10(v) - llo) / (lhi - llo));
  const ticks = niceLogTicks(lo, hi);
  const groupW = plotW / groups.length;
  const maxBars = Math.max(...groups.map((g) => g.bars.length));
  const barW = Math.min(44, (groupW * 0.7) / maxBars);
  const gap = Math.min(10, barW * 0.25);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" class="chart">`;
  for (const t of ticks) {
    const ty = y(t);
    svg += `<line x1="${padL}" y1="${ty}" x2="${
      W - padR
    }" y2="${ty}" stroke="#e8edf3" stroke-width="1"/>`;
    svg += `<text x="${padL - 8}" y="${
      ty + 4
    }" text-anchor="end" class="tick">${fmtUs(t)}</text>`;
  }
  groups.forEach((g, gi) => {
    const gx = padL + gi * groupW;
    const total = g.bars.length * barW + (g.bars.length - 1) * gap;
    let bx = gx + (groupW - total) / 2;
    for (const b of g.bars) {
      const by = y(b.value);
      svg += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${
        barW.toFixed(1)
      }" height="${
        (padT + plotH - by).toFixed(1)
      }" rx="4" fill="${b.color}" data-tip="${esc(b.tip)}"><title>${
        esc(b.tip)
      }</title></rect>`;
      bx += barW + gap;
    }
    svg += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${
      H - 12
    }" text-anchor="middle" class="xlabel">${esc(g.name)}</text>`;
  });
  svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${
    padT + plotH
  }" stroke="#c9d4e0" stroke-width="1"/>`;
  svg += `</svg>`;
  return svg;
}

function lineChart(
  series: {
    name: string;
    color: string;
    points: { x: number; y: number; tip: string }[];
  }[],
  xLabels: string[],
): string {
  const W = 370, H = 260, padL = 56, padR = 12, padT = 12, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = series.flatMap((s) => s.points.map((p) => p.y));
  const lo = Math.min(...vals) * 0.8, hi = Math.max(...vals) * 1.25;
  const llo = Math.log10(lo), lhi = Math.log10(hi);
  const y = (v: number) =>
    padT + plotH * (1 - (Math.log10(v) - llo) / (lhi - llo));
  const x = (i: number) =>
    padL +
    (xLabels.length === 1 ? plotW / 2 : (plotW * i) / (xLabels.length - 1));
  const ticks = niceLogTicks(lo, hi);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" class="chart">`;
  for (const t of ticks) {
    const ty = y(t);
    svg += `<line x1="${padL}" y1="${ty}" x2="${
      W - padR
    }" y2="${ty}" stroke="#e8edf3" stroke-width="1"/>`;
    svg += `<text x="${padL - 8}" y="${
      ty + 4
    }" text-anchor="end" class="tick">${fmtUs(t)}</text>`;
  }
  xLabels.forEach((l, i) => {
    svg += `<text x="${x(i).toFixed(1)}" y="${
      H - 10
    }" text-anchor="middle" class="tick">${esc(l)}</text>`;
  });
  for (const s of series) {
    const pts = s.points.map((p, i) =>
      `${x(i).toFixed(1)},${y(p.y).toFixed(1)}`
    ).join(" ");
    svg +=
      `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`;
    for (const [i, p] of s.points.entries()) {
      svg += `<circle cx="${x(i).toFixed(1)}" cy="${
        y(p.y).toFixed(1)
      }" r="4" fill="${s.color}" data-tip="${esc(p.tip)}"><title>${
        esc(p.tip)
      }</title></circle>`;
    }
  }
  svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${
    padT + plotH
  }" stroke="#c9d4e0" stroke-width="1"/>`;
  svg += `</svg>`;
  return svg;
}

function latencyCard(): string {
  const groups = SHAPES_FOR_FULL.map((shape) => {
    const bars = MATCHERS.flatMap((m) => {
      const r = pick(FULL, shape, m.key);
      if (!r) return [];
      return [{
        value: r.medianNs,
        color: m.color,
        tip: `${m.label} · ${shape}: median ${fmtUs(r.medianNs)}, p95 ${
          fmtUs(r.p95Ns)
        }, ${fmtInt(r.opsPerSec)} ops/s`,
      }];
    });
    return { name: shape, bars };
  });

  let table =
    `<table><thead><tr><th>Path shape</th><th>Matcher</th><th class="num">Median</th><th class="num">p95</th><th class="num">p99</th><th class="num">Ops/sec</th><th class="num">vs RE</th></tr></thead><tbody>`;
  for (const shape of SHAPES_FOR_FULL) {
    const re = pick(FULL, shape, "regex");
    const groupRows = MATCHERS.map((m) => ({ m, r: pick(FULL, shape, m.key) }));
    if (groupRows.some((g) => !g.r) || !re) continue;
    table += `<tr><td rowspan="${MATCHERS.length}">${esc(shape)}</td>`;
    for (const [i, { m, r }] of groupRows.entries()) {
      const vsRe = m.key === "regex"
        ? "(baseline)"
        : `${(re.medianNs / r!.medianNs).toFixed(2)}×`;
      table += `${
        i > 0 ? "<tr>" : ""
      }<td><span class="dot" style="background:${m.color}"></span>${m.label}</td><td class="num">${
        fmtUs(r!.medianNs)
      }</td><td class="num">${fmtUs(r!.p95Ns)}</td><td class="num">${
        fmtUs(r!.p99Ns)
      }</td><td class="num">${
        fmtInt(r!.opsPerSec)
      }</td><td class="num">${vsRe}</td></tr>`;
    }
  }
  table += `</tbody></table>`;

  return `<section class="card">
  <h2>Latency by path shape — full ${FULL}-route set</h2>
  <div class="note">Median dispatch time per request (log scale, lower is better). p95/p99 tail behavior matters for bursty traffic.</div>
  ${legend()}
  ${groupedBars(groups)}
  ${table}
</section>`;
}

function scalingCard(): string {
  const panels: string[] = [];
  for (const shape of ["real-matrix", "adversarial"]) {
    const series = MATCHERS.map((m) => ({
      name: m.name,
      color: m.color,
      points: sizes.map((s) => {
        const r = pick(s, shape, m.key)!;
        return {
          x: s,
          y: r.medianNs,
          tip: `${m.label} · ${shape} · ${s} routes: ${fmtUs(r.medianNs)}`,
        };
      }),
    }));
    panels.push(
      `<figure><figcaption>${
        esc(shape)
      } — median vs route-set size</figcaption>${
        lineChart(series, sizes.map(String))
      }</figure>`,
    );
  }
  return `<section class="card">
  <h2>Scaling — median latency vs route-set size</h2>
  <div class="note">How each matcher degrades as the route table grows (log scale).</div>
  ${legend()}
  <div class="panels">${panels.join("")}</div>
  <div class="flatnote"><strong>Fixed-corpus flatness: ${FLATNESS.ratio}×</strong> — compiled median on the
  <em>same</em> ${FLATNESS.hits} shared-hit paths at 10 vs ${FLATNESS.full} routes
  (${fmtInt(FLATNESS.median10)} ns → ${
    fmtInt(FLATNESS.medianFull)
  } ns). Per-set medians confound
  route-set size with hit-rate (the first 10 matrix routes are all static); this measures
  route-count cost directly. Gate: ≤ 2×.</div>
</section>`;
}

function constructionCard(): string {
  const series = MATCHERS.map((m) => ({
    m,
    vals: sizes.map((s) =>
      pick(s, "real-matrix", "state-machine")
        ? pick(s, "real-matrix", m.key)?.constructionMs ?? 0
        : 0
    ),
  }));
  const W = 760, H = 260, padL = 56, padR = 10, padT = 12, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = series.flatMap((s) => s.vals);
  const hi = Math.max(...all) * 1.15;
  const y = (v: number) => padT + plotH * (1 - v / hi);
  const ticks = niceLinTicks(0, hi, 5);
  const groupW = plotW / sizes.length;
  const barW = Math.min(30, (groupW * 0.6) / MATCHERS.length);
  const gap = 4;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" class="chart">`;
  for (const t of ticks) {
    const ty = y(t);
    svg += `<line x1="${padL}" y1="${ty}" x2="${
      W - padR
    }" y2="${ty}" stroke="#e8edf3" stroke-width="1"/>`;
    svg += `<text x="${padL - 8}" y="${
      ty + 4
    }" text-anchor="end" class="tick">${t.toFixed(1)} ms</text>`;
  }
  sizes.forEach((size, i) => {
    const gx = padL + i * groupW;
    const total = MATCHERS.length * barW + (MATCHERS.length - 1) * gap;
    let bx = gx + (groupW - total) / 2;
    for (const { m, vals } of series) {
      svg += `<rect x="${bx.toFixed(1)}" y="${
        y(vals[i]).toFixed(1)
      }" width="${barW}" height="${
        (padT + plotH - y(vals[i])).toFixed(1)
      }" rx="3" fill="${m.color}" data-tip="${
        esc(`${m.label} · ${size} routes: ${vals[i].toFixed(2)} ms build`)
      }"><title>${
        esc(`${m.label} · ${size} routes: ${vals[i].toFixed(2)} ms build`)
      }</title></rect>`;
      bx += barW + gap;
    }
    svg += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${
      H - 12
    }" text-anchor="middle" class="xlabel">${size}</text>`;
  });
  svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${
    padT + plotH
  }" stroke="#c9d4e0" stroke-width="1"/>`;
  svg += `</svg>`;

  return `<section class="card">
  <h2>Construction time</h2>
  <div class="note">One-time cost of building each matcher from the route table (RE compiles regexes up front; compiled builds the radix automaton).</div>
  ${legend()}
  ${svg}
</section>`;
}

function fullTableCard(): string {
  let html =
    `<table><thead><tr><th>Path shape</th><th>Matcher</th><th class="num">Median</th><th class="num">p95</th><th class="num">p99</th><th class="num">Ops/sec</th><th class="num">Build (ms)</th></tr></thead><tbody>`;
  for (const size of sizes) {
    const groupRows = rows.filter((r) => r.routeSetSize === size);
    const shapes = [...new Set(groupRows.map((r) => r.pathShape))];
    html +=
      `<tr class="group"><td colspan="7">Route set — ${size} routes</td></tr>`;
    for (const shape of shapes) {
      for (const m of MATCHERS) {
        const r = groupRows.find((x) =>
          x.pathShape === shape && x.matcher === m.key
        );
        if (!r) continue;
        html += `<tr><td>${
          esc(shape)
        }</td><td><span class="dot" style="background:${m.color}"></span>${m.label}</td><td class="num">${
          fmtUs(r.medianNs)
        }</td><td class="num">${fmtUs(r.p95Ns)}</td><td class="num">${
          fmtUs(r.p99Ns)
        }</td><td class="num">${fmtInt(r.opsPerSec)}</td><td class="num">${
          r.constructionMs.toFixed(2)
        }</td></tr>`;
      }
    }
  }
  html += `</tbody></table>`;
  return `<section class="card">
  <h2>All benchmark results</h2>
  ${html}
</section>`;
}

const deno = Deno.version;
const genDate = new Date().toISOString().slice(0, 10);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pathfinder — matcher benchmarks</title>
<style>
:root { --ink:#0f172a; --dim:#64748b; --card:#ffffff; --bg:#f4f6f9; --line:#e2e8f0; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:1000px; margin:0 auto; padding:34px 20px 70px; }
h1 { margin:0 0 2px; font-size:27px; letter-spacing:-0.02em; }
.sub { color:var(--dim); font-size:14px; margin-bottom:14px; }
.banner { display:flex; gap:20px; align-items:center; background:#eafaf3; border:1px solid #a9e6cc; border-radius:14px; padding:18px 22px; margin:18px 0; }
.badge { background:${RE_COLOR}; color:#fff; font-weight:800; letter-spacing:.1em; padding:12px 18px; border-radius:10px; font-size:21px; }
.banner .big { font-size:21px; font-weight:700; }
.banner .dim { color:var(--dim); font-size:13.5px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px 22px; margin:18px 0; }
.card h2 { margin:0 0 10px; font-size:18px; letter-spacing:-0.01em; }
.card .note { color:var(--dim); font-size:13px; margin:2px 0 12px; }
table { border-collapse:collapse; width:100%; font-size:13.5px; }
th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); }
th { color:var(--dim); font-weight:600; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
tr.group td { background:#f1f5f9; color:var(--dim); font-weight:600; font-size:12.5px; }
.dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; }
.legend { display:flex; gap:18px; margin:2px 0 12px; }
.chip { display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--dim); }
.swatch { width:12px; height:12px; border-radius:3px; }
.chart { width:100%; height:auto; display:block; }
.tick { font-size:11px; fill:var(--dim); font-family:inherit; }
.xlabel { font-size:12px; fill:var(--ink); font-family:inherit; }
svg rect, svg circle { cursor:default; }
.chapters { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); gap:12px; margin-top:6px; }
.chapter { border:1px solid var(--line); border-radius:10px; padding:13px 15px; background:#fbfcfe; }
.chapter h3 { margin:0 0 6px; font-size:14px; }
.chapter ul { margin:0; padding-left:18px; }
.chapter li { font-size:13px; color:#334155; margin:3px 0; }
.panels { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width:760px){ .panels { grid-template-columns:1fr; } }
figure { margin:0; }
figcaption { font-size:13px; color:var(--dim); margin-bottom:6px; }
.flatnote { margin-top:14px; border-left:3px solid ${COM_COLOR}; background:#fdf6ec; padding:10px 14px; font-size:13px; color:#334155; border-radius:0 8px 8px 0; }
.env { font-size:13px; }
.env td { padding:4px 10px; }
.env td:first-child { color:var(--dim); }
#tip { position:fixed; pointer-events:none; opacity:0; background:#0f172a; color:#fff; font-size:12.5px; padding:7px 10px; border-radius:8px; transition:opacity .08s; z-index:10; max-width:340px; }
@media print { body { background:#fff; } .card,.banner { break-inside:avoid; } }
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Pathfinder — matcher benchmarks</h1>
  <div class="sub">Three matcher models on one corpus: the state machine (SM, the frozen behavioral oracle), the regex baseline (RE, path-to-regexp 8.2.0), and the compiled chunk automaton — the product. Generated ${genDate}.</div>
  <table class="env">
    <tr><td>Deno</td><td>${deno.deno}</td><td>V8</td><td>${deno.v8}</td><td>TypeScript</td><td>${deno.typescript}</td></tr>
    <tr><td>OS</td><td>${Deno.build.os}</td><td>Arch</td><td>${Deno.build.arch}</td><td>Benchmark</td><td>end-to-end dispatch, 5000 iter/sample</td></tr>
  </table>
</header>

<section class="banner">
  <div class="badge">PASS</div>
  <div>
    <div class="big">0 mismatches — three-way behavioral parity</div>
    <div class="dim">${PARITY.routes} routes × ${PARITY.paths} paths · SM ≡ RE ≡ compiled on the shared corpus; showcase shapes: compiled ≡ RE · correctness run of ${PARITY.asOf}</div>
  </div>
</section>

${latencyCard()}

${scalingCard()}

${constructionCard()}

${fullTableCard()}

</div>
<div id="tip"></div>
<script>
const tip = document.getElementById("tip");
document.addEventListener("mousemove", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el) {
    tip.textContent = el.dataset.tip;
    tip.style.opacity = "1";
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 360) + "px";
    tip.style.top = (e.clientY + 14) + "px";
  } else {
    tip.style.opacity = "0";
  }
});
</script>
</body>
</html>
`;

await Deno.writeTextFile(OUT_FILE, html);
console.log(
  `dashboard: wrote ${OUT_FILE} (${(html.length / 1024).toFixed(1)} KB)`,
);
