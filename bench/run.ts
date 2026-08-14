// Top-level benchmark runner. Orchestrates each layer as an ISOLATED subprocess
// (so one layer's memory/JIT state can't bias another), collects their JSON,
// and writes a single Markdown report plus the raw results.
//
//   deno run -A bench/run.ts                 # all layers (1=bytes, 2=SSR, 3=runtime)
//   deno run -A bench/run.ts --layers=1,3    # a subset
//
// Layers 1 (bytes over the wire) and 3 (hydration + interaction) share one
// browser harness — it serves both production builds and drives headless Chrome.
// Layer 2 (SSR throughput) runs the denext bench under Deno and React under Node.
// React/Next come from bench/node_modules (never a denext dependency).
//
// Prereq for layers 1/3: the Next fixture must be built once —
//   (cd bench/fixtures/next-hello && ../../node_modules/.bin/next build)

import { join } from "@std/path";
import {
  captureProvenance,
  nodeVersion,
  type Provenance,
} from "./lib/provenance.ts";
import {
  type BenchRow,
  type BrowserData,
  headerSection,
  layer1Section,
  layer2Section,
  layer3Section,
  summarySection,
} from "./lib/report.ts";

const BENCH = new URL(".", import.meta.url).pathname;
const DENO = Deno.execPath();
// denext-side scripts import the framework's build/SSR code, which uses bare
// "@std/*" specifiers resolved by the repo-root deno.json. bench/package.json
// would otherwise shadow that into node resolution, so pin the config explicitly.
const ROOT_CONFIG = join(BENCH, "..", "deno.json");

function argLayers(): Set<string> {
  const arg = Deno.args.find((a) => a.startsWith("--layers="));
  if (!arg) return new Set(["1", "2", "3"]);
  return new Set(arg.slice("--layers=".length).split(",").map((s) => s.trim()));
}

async function nextVersion(): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(
      await Deno.readTextFile(join(BENCH, "node_modules/next/package.json")),
    );
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** Run a subprocess, capture stdout JSON; stream stderr through for progress. */
async function runJson(
  bin: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<unknown> {
  console.error(`\n$ ${bin} ${args.join(" ")}`);
  const out = await new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    env: { ...Deno.env.toObject(), NEXT_TELEMETRY_DISABLED: "1" },
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!out.success) {
    throw new Error(`subprocess failed: ${bin} ${args.join(" ")}`);
  }
  const text = new TextDecoder().decode(out.stdout).trim();
  return JSON.parse(text);
}

const layers = argLayers();
const now = new Date().toISOString();
const prov: Provenance = captureProvenance(now);
prov.node = await nodeVersion();

const sections: string[] = [];

// ── Layers 1 & 3: browser (bytes over the wire + client runtime) ─────────────
// One browser run produces both; keep report order 1 … 2 … 3.
let browser: BrowserData | undefined;
let layer1Md = "", layer3Md = "";
if (layers.has("1") || layers.has("3")) {
  prov.next = await nextVersion();
  browser = await runJson(DENO, [
    "run",
    "-A",
    "--config",
    ROOT_CONFIG,
    join(BENCH, "browser/run.ts"),
  ]) as BrowserData;
  if (layers.has("1")) layer1Md = layer1Section(browser);
  if (layers.has("3")) layer3Md = layer3Section(browser);
}
if (layer1Md) sections.push(layer1Md);

// ── Layer 2: SSR render throughput ───────────────────────────────────────────
let layer2: BenchRow[] | undefined;
if (layers.has("2")) {
  const denext = await runJson(DENO, [
    "run",
    "-A",
    "--config",
    ROOT_CONFIG,
    "--v8-flags=--expose-gc",
    join(BENCH, "layer2-ssr/run-denext.ts"),
  ]) as BenchRow[];
  const react = await runJson("node", [
    "--expose-gc",
    join(BENCH, "layer2-ssr/run-react.mjs"),
  ], { cwd: join(BENCH, "layer2-ssr") }) as BenchRow[];
  const reactVer = (react[0] as unknown as { reactVersion?: string })
    ?.reactVersion;
  if (reactVer) prov.react = reactVer;
  layer2 = [...denext, ...react];
  sections.push(layer2Section(layer2));
}

// Layer 3 comes last in report order.
if (layer3Md) sections.push(layer3Md);

// ── Assemble ─────────────────────────────────────────────────────────────────
const summary = browser ? [summarySection(browser)] : [];
const report = [headerSection(prov), ...summary, ...sections].join("\n");

const resultsDir = join(BENCH, "results");
await Deno.mkdir(resultsDir, { recursive: true });
const stamp = now.replace(/[:.]/g, "-");
await Deno.writeTextFile(join(resultsDir, `report-${stamp}.md`), report);
await Deno.writeTextFile(join(BENCH, "REPORT.md"), report);
await Deno.writeTextFile(
  join(resultsDir, `raw-${stamp}.json`),
  JSON.stringify({ provenance: prov, browser, layer2 }, null, 2),
);

console.error(
  `\n✅ Report written to bench/REPORT.md (and results/report-${stamp}.md)`,
);
console.log(report);
