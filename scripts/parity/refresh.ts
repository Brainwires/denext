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
  //
  // `--legacy-peer-deps`: we want the LATEST of each package independently. Without it,
  // an older package's peer range (Remix v2 peers React ^18) makes npm resolve React
  // *down* to 18 to satisfy the peer — silently downgrading the react/react-dom baseline
  // from 19. Ignoring peer reconciliation keeps every package at its own `latest`; a
  // package's own `.d.ts` (what the extractor reads) doesn't depend on the peer version.
  const install = await new Deno.Command("npm", {
    args: ["install", "--no-audit", "--no-fund", "--loglevel=error", "--legacy-peer-deps"],
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
  const versions = versionLines(oldB.versions, next.versions);
  const surfaces = surfaceChangeLines(oldB.surfaces, next.surfaces);
  const lines = [
    "parity drift report (live latest vs committed baseline):",
    "",
    "versions:",
    ...versions.lines,
    "",
    "surface changes:",
    ...surfaces.lines,
  ];
  if (!versions.changed && !surfaces.changed) {
    lines.push("  (no upstream drift — baseline is current)");
  }
  return lines.join("\n");
}

/** One line per real package: `→` marks a version that moved. */
function versionLines(
  was: Record<string, string>,
  now: Record<string, string>,
): { lines: string[]; changed: boolean } {
  const lines = REAL_PACKAGES.map((p) => {
    const a = was[p] ?? "—";
    const b = now[p] ?? "—";
    return a === b ? `    ${p}: ${a}` : `  → ${p}: ${a}  →  ${b}`;
  });
  return { lines, changed: REAL_PACKAGES.some((p) => (was[p] ?? "—") !== (now[p] ?? "—")) };
}

/** Added/removed symbols per specifier present in both baselines. */
function surfaceChangeLines(
  oldSurfaces: Surface[],
  nextSurfaces: Surface[],
): { lines: string[]; changed: boolean } {
  const oldBySpec = new Map(oldSurfaces.map((s) => [s.specifier, s]));
  const lines = nextSurfaces.flatMap((s) => {
    const prev = oldBySpec.get(s.specifier);
    return prev ? symbolDiffLines(s.specifier, prev.symbols, s.symbols) : [];
  });
  return { lines, changed: lines.length > 0 };
}

/** `  spec:` + `+ added` / `- removed` lines, or nothing when the symbol set is unchanged. */
function symbolDiffLines(
  specifier: string,
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const added = Object.keys(next).filter((n) => !(n in prev));
  const removed = Object.keys(prev).filter((n) => !(n in next));
  const body = [...diffLine("+", added), ...diffLine("-", removed)];
  return body.length ? [`  ${specifier}:`, ...body] : [];
}

/** `    + a, b` (or `-`), or nothing for an empty list. */
function diffLine(sign: string, names: string[]): string[] {
  return names.length ? [`    ${sign} ${names.join(", ")}`] : [];
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
