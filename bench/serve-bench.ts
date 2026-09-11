// SPDX-License-Identifier: LGPL-3.0-only

// Serve-level perf harness: a real routing server under the production
// pathfinder() factory, measured over the wire AND in-process. Two modes —
// wire proves the real server; direct isolates the walk/dispatch from
// socket noise. Results go to stdout as JSON; nothing here writes to the
// tree (bench-results.json is the curated spike-lab snapshot, untouched).
//
//   deno run --allow-net --allow-read bench/serve-bench.ts            (both)
//   deno run --allow-net --allow-read bench/serve-bench.ts wire      (wire only)
//   deno run --allow-net --allow-read bench/serve-bench.ts direct    (direct only)
//
// Scenarios isolate one hot path each. The deep no-match scenario targets a
// subtree with no custom outcome file, so the renderer work is identical
// (vacuum bare 404) across code revisions — only the anchor machinery
// differs. The _matrix fixture exists for the non-timed correctness probe.

import { pathfinder } from "../mod.ts";
import type { PathfinderApp } from "../mod.ts";

// --- Scenario table ----------------------------------------------------------

interface Scenario {
  name: string;
  method: string;
  path: string;
  /** Expected status — asserted on warmup; wrong status fails the run. */
  expect: number;
}

const SCENARIOS: Scenario[] = [
  { name: "static-match", method: "GET", path: "/health", expect: 200 },
  {
    name: "dynamic-match",
    method: "GET",
    path: "/api/devices/42/settings/7",
    expect: 200,
  },
  {
    name: "deep-no-match",
    method: "GET",
    path: "/api/devices/42/unknown",
    expect: 404,
  },
  {
    name: "method-miss",
    method: "DELETE",
    path: "/api/devices/42",
    expect: 405,
  },
  { name: "root-no-match", method: "GET", path: "/zebra", expect: 404 },
];

// --- Protocol ----------------------------------------------------------------

const WARMUP_MS = 2_000;
const WIRE_REQUESTS = 10_000;
const DIRECT_REQUESTS = 100_000;
const RUNS = 3; // per scenario; the best median is kept

interface ScenarioResult {
  scenario: string;
  mode: "wire" | "direct";
  medianUsPerReq: number;
  p95UsPerReq: number;
  opsPerSec: number;
  requests: number;
}

// --- Measurement core ----------------------------------------------------------

/** One timed pass of serial requests; returns per-request latencies in µs. */
async function measure(
  count: number,
  fire: () => Promise<Response>,
): Promise<BigUint64Array> {
  const latencies = new BigUint64Array(count);
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const response = await fire();
    await response.arrayBuffer(); // drain (keep-alive hygiene)
    latencies[i] = BigInt(
      Math.max(1, Math.round((performance.now() - t0) * 1000)),
    );
  }
  return latencies;
}

function sortedCopy(latencies: BigUint64Array): BigUint64Array {
  const sorted = latencies.slice();
  sorted.sort();
  return sorted; // BigUint64Array.sort() is numeric ascending
}

function summarize(
  scenario: string,
  mode: "wire" | "direct",
  latencies: BigUint64Array,
): ScenarioResult {
  const sorted = sortedCopy(latencies);
  const medianUs = Number(sorted[Math.floor(sorted.length / 2)]);
  const p95Us = Number(sorted[Math.floor(sorted.length * 0.95)]);
  return {
    scenario,
    mode,
    medianUsPerReq: medianUs,
    p95UsPerReq: p95Us,
    opsPerSec: medianUs > 0 ? 1_000_000 / medianUs : 0,
    requests: latencies.length,
  };
}

/** Warmup + correctness probe: scenario must return its expected status. */
async function warmup(
  scenario: Scenario,
  fire: () => Promise<Response>,
): Promise<void> {
  const deadline = Date.now() + WARMUP_MS;
  let status = 0;
  while (Date.now() < deadline) {
    status = (await fire()).status;
  }
  if (status !== scenario.expect) {
    throw new Error(
      `[serve-bench] ${scenario.name}: probe returned ${status}, expected ${scenario.expect}`,
    );
  }
}

/** Best-of-RUNS measurement for one scenario in one mode. */
async function bestOf(
  scenario: Scenario,
  mode: "wire" | "direct",
  count: number,
  makeFire: () => () => Promise<Response>,
): Promise<ScenarioResult> {
  await warmup(scenario, makeFire());
  let best: ScenarioResult | null = null;
  for (let run = 0; run < RUNS; run++) {
    const latencies = await measure(count, makeFire());
    const candidate = summarize(scenario.name, mode, latencies);
    if (best === null || candidate.opsPerSec > best.opsPerSec) best = candidate;
  }
  return best!;
}

// --- Modes -------------------------------------------------------------------

async function wireBench(app: PathfinderApp): Promise<ScenarioResult[]> {
  const server = Deno.serve({ port: 0 }, app);
  const port = (server.addr as Deno.NetAddr).port;
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of SCENARIOS) {
      const url = `http://localhost:${port}${scenario.path}`;
      const fire = () => fetch(url, { method: scenario.method });
      results.push(await bestOf(scenario, "wire", WIRE_REQUESTS, () => fire));
    }
  } finally {
    await server.shutdown();
  }
  return results;
}

async function directBench(app: PathfinderApp): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    const fire = () =>
      app(
        new Request(`http://bench.local${scenario.path}`, {
          method: scenario.method,
        }),
      );
    results.push(await bestOf(scenario, "direct", DIRECT_REQUESTS, () => fire));
  }
  return results;
}

// --- Main --------------------------------------------------------------------

const mode = (Deno.args[0] ?? "both") as "wire" | "direct" | "both";
const app = await pathfinder({ roots: ["./bench/fixtures/serve/endpoints/"] });

const results: ScenarioResult[] = [];
if (mode === "wire" || mode === "both") results.push(...await wireBench(app));
if (mode === "direct" || mode === "both") {
  results.push(...await directBench(app));
}

// Correctness probe (non-timed): the _matrix leafless-dir 404 must carry the
// subtree's M_UNRECOGNIZED errcode — the leafless-dir anchoring behavior.
{
  const response = await app(
    new Request("http://bench.local/_matrix/client/v3/nope"),
  );
  const body = await response.json() as { errcode?: string };
  if (response.status !== 404 || body.errcode !== "M_UNRECOGNIZED") {
    throw new Error(
      `[serve-bench] correctness probe failed: _matrix 404 page did not fire (status ${response.status})`,
    );
  }
  console.error(
    "[serve-bench] correctness probe: _matrix/404.ts fired (leafless dir anchors)",
  );
}

console.log(JSON.stringify(results, null, 2));
