// Refresh / drift tool for the React/ReactDOM/Next parity baseline.
//
//   deno task parity:refresh   # install latest, extract real surface, WRITE baseline
//   deno task parity:drift     # install latest, compare to committed baseline, print
//                              # what changed upstream — never writes, never fails CI
//
// The real surface is captured into a committed snapshot
// (`tests/fixtures/react-surface.baseline.json`) so the parity TEST
// (`tests/react-parity.test.ts`) runs offline against a fixed point. This script is
// the only part that touches npm/network; it installs into a throwaway temp dir (via
// Deno's `--node-modules-dir=auto`) so the repo root stays clean.

import { REAL_PACKAGES } from "./spec.ts";
import type { Baseline, Surface } from "./types.ts";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const BASELINE = `${ROOT}/tests/fixtures/react-surface.baseline.json`;
const RUNNER = new URL("./_real-runner.ts", import.meta.url).pathname;

/** Install the real packages into `dir` and extract their surface in a child deno. */
async function captureReal(
  dir: string,
): Promise<{ versions: Record<string, string>; surfaces: Surface[] }> {
  const deps = Object.fromEntries(REAL_PACKAGES.map((p) => [p, "latest"]));
  // typescript is the extractor's own dependency; pin a major so resolution is stable.
  deps["typescript"] = "^5";
  await Deno.writeTextFile(
    `${dir}/package.json`,
    JSON.stringify({ name: "denext-parity-real", private: true, dependencies: deps }, null, 2),
  );

  // Materialize ALL package.json deps into node_modules. Deno's --node-modules-dir
  // only installs what the module graph imports (i.e. typescript), so the react/next
  // .d.ts the TS compiler API needs must be installed explicitly via npm.
  const install = await new Deno.Command("npm", {
    args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (install.code !== 0) {
    throw new Error(`npm install failed:\n${new TextDecoder().decode(install.stderr)}`);
  }

  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--node-modules-dir=auto", RUNNER, dir],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const err = new TextDecoder().decode(stderr);
  if (code !== 0) throw new Error(`real-surface extraction failed:\n${err}`);
  const text = new TextDecoder().decode(stdout).trim();
  // The child may print deno's npm "Download/Initialize" lines to stdout on first run;
  // take the last line, which is our JSON payload.
  const jsonLine = text.split("\n").filter((l) => l.startsWith("{")).at(-1)!;
  return JSON.parse(jsonLine);
}

function summarizeDrift(
  oldB: Baseline,
  next: { versions: Record<string, string>; surfaces: Surface[] },
): string {
  const lines: string[] = ["parity drift report (live latest vs committed baseline):", ""];
  let changed = false;

  lines.push("versions:");
  for (const p of REAL_PACKAGES) {
    const was = oldB.versions[p] ?? "—";
    const now = next.versions[p] ?? "—";
    const mark = was === now ? "  " : "→ ";
    if (was !== now) changed = true;
    lines.push(`  ${mark}${p}: ${was}${was === now ? "" : `  →  ${now}`}`);
  }

  const oldBySpec = new Map(oldB.surfaces.map((s) => [s.specifier, s]));
  lines.push("", "surface changes:");
  for (const s of next.surfaces) {
    const prev = oldBySpec.get(s.specifier);
    if (!prev) continue;
    const added = Object.keys(s.symbols).filter((n) => !(n in prev.symbols));
    const removed = Object.keys(prev.symbols).filter((n) => !(n in s.symbols));
    if (added.length || removed.length) {
      changed = true;
      lines.push(`  ${s.specifier}:`);
      if (added.length) lines.push(`    + ${added.join(", ")}`);
      if (removed.length) lines.push(`    - ${removed.join(", ")}`);
    }
  }
  if (!changed) lines.push("  (no upstream drift — baseline is current)");
  return lines.join("\n");
}

async function main() {
  const drift = Deno.args.includes("--latest");
  const dir = await Deno.makeTempDir({ prefix: "denext_parity_" });
  try {
    console.error(`installing ${REAL_PACKAGES.join(", ")} (latest) into ${dir} …`);
    const captured = await captureReal(dir);

    if (drift) {
      const oldB = JSON.parse(await Deno.readTextFile(BASELINE)) as Baseline;
      console.log(summarizeDrift(oldB, captured));
      return;
    }

    const baseline: Baseline = {
      versions: captured.versions,
      capturedAt: new Date().toISOString(),
      surfaces: captured.surfaces,
    };
    await Deno.mkdir(`${ROOT}/tests/fixtures`, { recursive: true });
    await Deno.writeTextFile(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
    const symCount = captured.surfaces.reduce((n, s) => n + Object.keys(s.symbols).length, 0);
    const resolved = captured.surfaces.filter((s) => s.resolved).length;
    console.log(
      `wrote baseline: ${symCount} real symbols across ${resolved}/${captured.surfaces.length} resolved ` +
        `specifiers → ${BASELINE}`,
    );
    console.log("versions:", JSON.stringify(captured.versions));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

if (import.meta.main) await main();
