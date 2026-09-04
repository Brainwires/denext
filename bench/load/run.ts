// Layer 4 — high-volume load + memory. Fires a large burst of concurrent requests
// at a running production server and measures throughput, latency percentiles,
// error rate, and the server process's resident memory (RSS) under load. Each
// server runs in its OWN process; the load generator (this process) samples the
// server's RSS via `ps`, so the memory figure is the server's alone.
//
//   deno run -A --config deno.json bench/load/run.ts
//   BENCH_LOAD_TOTAL=5000 BENCH_LOAD_CONCURRENCY=100 BENCH_LOAD_PATH=/ deno run ... bench/load/run.ts
//
// denext is always measured. Next.js is measured too when its fixture is built
// (bench/fixtures/next-hello/.next) and the next binary is present — otherwise the
// Next side is skipped with a note (never a failure).

import { join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { captureProvenance, nodeVersion } from "../lib/provenance.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const DENEXT_APP = join(REPO, "examples/hello");
const NEXT_APP = join(REPO, "bench/fixtures/next-hello");
const NEXT_BIN = join(REPO, "bench/node_modules/.bin/next");
const DENO = Deno.execPath();
const ROOT_CONFIG = join(REPO, "deno.json");

const TOTAL = Number(Deno.env.get("BENCH_LOAD_TOTAL") ?? 5000);
const CONCURRENCY = Number(Deno.env.get("BENCH_LOAD_CONCURRENCY") ?? 100);
const PATH = Deno.env.get("BENCH_LOAD_PATH") ?? "/";
const WARMUP = Number(Deno.env.get("BENCH_LOAD_WARMUP") ?? 50);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LoadResult {
  count: number;
  errors: number;
  durationMs: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Fire `total` requests at `origin+path`, holding at most `concurrency` in flight. */
async function loadTest(
  origin: string,
  total: number,
  concurrency: number,
): Promise<LoadResult> {
  const url = origin + PATH;
  const latencies = new Float64Array(total);
  let issued = 0;
  let errors = 0;

  const worker = async () => {
    for (;;) {
      const i = issued++;
      if (i >= total) return;
      const t0 = performance.now();
      if (!(await fetchOk(url))) errors++;
      latencies[i] = performance.now() - t0;
    }
  };

  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const durationMs = performance.now() - start;

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: total,
    errors,
    durationMs,
    rps: (total / durationMs) * 1000,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

/** One request; the body is drained so the connection is freed and the render fully completes. */
async function fetchOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    await res.arrayBuffer();
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Resident set size (bytes) of a process via `ps`, or null if unavailable. */
async function rss(pid: number): Promise<number | null> {
  const kb = await psRssKb(pid);
  return kb !== null && Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
}

/** `ps -o rss= -p <pid>` as a number, or null when ps is unavailable or fails. */
async function psRssKb(pid: number): Promise<number | null> {
  try {
    const out = await new Deno.Command("ps", {
      args: ["-o", "rss=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success ? Number(new TextDecoder().decode(out.stdout).trim()) : null;
  } catch {
    return null;
  }
}

/** Poll a PID's RSS until stopped; returns the peak seen. */
function rssSampler(pid: number): { stop: () => Promise<number> } {
  let peak = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const r = await rss(pid);
      if (r && r > peak) peak = r;
      await sleep(50);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return peak;
    },
  };
}

interface FrameworkResult {
  framework: string;
  load: LoadResult;
  rssBeforeBytes: number | null;
  rssPeakBytes: number | null;
}

/** Warm up, sample idle RSS, run the load while sampling peak RSS. */
async function measure(
  framework: string,
  origin: string,
  pid: number,
): Promise<FrameworkResult> {
  // Warm up (JIT, lazy module init, connection setup) before measuring.
  await loadTest(origin, WARMUP, Math.min(WARMUP, 20));
  await sleep(200);
  const rssBeforeBytes = await rss(pid);

  const sampler = rssSampler(pid);
  const load = await loadTest(origin, TOTAL, CONCURRENCY);
  const rssPeakBytes = await sampler.stop();

  return { framework, load, rssBeforeBytes, rssPeakBytes };
}

async function waitReady(child: Deno.ChildProcess): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    const m = buf.match(/READY (\S+)/);
    if (m) {
      reader.releaseLock();
      return m[1];
    }
  }
  throw new Error("denext server never signaled READY");
}

async function waitReachable(origin: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(origin + "/", { redirect: "manual" });
      await r.body?.cancel();
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`${origin} never became reachable`);
      }
      await sleep(250);
    }
  }
}

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

// ── denext ───────────────────────────────────────────────────────────────────
console.error(
  `\nLoad: ${TOTAL} requests @ concurrency ${CONCURRENCY} to ${PATH}`,
);
console.error("Building denext app…");
await build(DENEXT_APP);

console.error("Starting denext server (separate process)…");
const denextChild = new Deno.Command(DENO, {
  args: [
    "run",
    "-A",
    "--unstable-kv",
    "--config",
    ROOT_CONFIG,
    join(REPO, "bench/load/denext-server.ts"),
    DENEXT_APP,
  ],
  stdout: "piped",
  stderr: "null",
}).spawn();
const denextOrigin = await waitReady(denextChild);
const results: FrameworkResult[] = [];
try {
  results.push(await measure("denext", denextOrigin, denextChild.pid));
} finally {
  try {
    denextChild.kill("SIGTERM");
  } catch { /* already gone */ }
  await denextChild.status.catch(() => {});
}

// ── Next.js (optional) ─────────────────────────────────────────────────────────
let nextBuilt = false;
try {
  await Deno.stat(join(NEXT_APP, ".next"));
  await Deno.stat(NEXT_BIN);
  nextBuilt = true;
} catch { /* Next fixture not built / binary absent → skip */ }

if (nextBuilt) {
  console.error("Starting Next.js server (next start)…");
  const port = freePort();
  const nextChild = new Deno.Command(NEXT_BIN, {
    args: ["start", "-p", String(port)],
    cwd: NEXT_APP,
    env: { ...Deno.env.toObject(), NEXT_TELEMETRY_DISABLED: "1" },
    stdout: "null",
    stderr: "null",
  }).spawn();
  const nextOrigin = `http://127.0.0.1:${port}`;
  try {
    await waitReachable(nextOrigin);
    results.push(await measure("next", nextOrigin, nextChild.pid));
  } finally {
    try {
      nextChild.kill("SIGTERM");
    } catch { /* already gone */ }
    await nextChild.status.catch(() => {});
  }
} else {
  console.error(
    "Next.js fixture not built — skipping the head-to-head. Build it with:\n" +
      "  (cd bench/fixtures/next-hello && ../../node_modules/.bin/next build)",
  );
}

// ── Report ─────────────────────────────────────────────────────────────────────
const prov = captureProvenance(new Date().toISOString());
prov.node = await nodeVersion();

const mb = (
  b: number | null,
) => (b == null ? "n/a" : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ms = (n: number) => `${n.toFixed(1)} ms`;

const lines: string[] = [];
lines.push("# Load & Memory Benchmark");
lines.push("");
lines.push(`- ${prov.timestamp}`);
lines.push(`- ${prov.cpu} · ${prov.cores} cores · ${prov.os}/${prov.arch}`);
lines.push(`- deno ${prov.deno}${prov.node ? ` · node ${prov.node}` : ""}`);
lines.push(
  `- workload: **${TOTAL}** requests, concurrency **${CONCURRENCY}**, path \`${PATH}\``,
);
lines.push("");
lines.push(
  "| Framework | req/s | p50 | p95 | p99 | max | errors | RSS idle | RSS peak |",
);
lines.push("| --- | --: | --: | --: | --: | --: | --: | --: | --: |");
for (const r of results) {
  lines.push(
    `| ${r.framework} | ${r.load.rps.toFixed(0)} | ${ms(r.load.p50)} | ${ms(r.load.p95)} | ${
      ms(r.load.p99)
    } | ${ms(r.load.max)} | ${r.load.errors} | ${mb(r.rssBeforeBytes)} | ${mb(r.rssPeakBytes)} |`,
  );
}
if (!nextBuilt) {
  lines.push("");
  lines.push("> Next.js side skipped (fixture not built). denext-only run.");
}
const report = lines.join("\n");

const resultsDir = join(REPO, "bench/results");
await Deno.mkdir(resultsDir, { recursive: true });
const stamp = prov.timestamp.replace(/[:.]/g, "-");
await Deno.writeTextFile(join(resultsDir, `load-${stamp}.md`), report + "\n");

console.error("\n" + report + "\n");
console.log(
  JSON.stringify(
    { provenance: prov, workload: { TOTAL, CONCURRENCY, PATH }, results },
    null,
    2,
  ),
);
