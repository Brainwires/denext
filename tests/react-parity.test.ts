// Structural signature-parity gate: denext's `react` / `react-dom` / `next`(-adjacent)
// compat surface must not deviate from the real React/ReactDOM/Next surface.
//
// Runs OFFLINE in the normal suite: it diffs denext's live surface (extracted via
// `deno doc` over `src/compat/**`) against the committed real-surface baseline
// (`tests/fixtures/react-surface.baseline.json`, produced by `deno task parity:refresh`
// from the pinned latest npm packages). A failure means a real runtime export is
// missing, exposed as type-only, has an incompatible arity, or is missing object
// members — the things that break `import { x } from "react"` or a real call site.
// Intentional differences live in `scripts/parity/waivers.ts`.
//
// To update after a React/Next release: `deno task parity:refresh`, review the diff,
// then add/adjust waivers as needed. `deno task parity:drift` previews upstream changes
// without writing.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { REACT_COMPAT_VERSION } from "../src/compat/react-version.ts";
import { assertCatalogMatchesExports, CATALOG, readBaselines } from "../scripts/parity/spec.ts";
import { docFor, extractDenextSurfaces } from "../scripts/parity/extract-denext.ts";
import { diffSurfaces, findingKey, formatReport } from "../scripts/parity/diff.ts";
import { WAIVERS } from "../scripts/parity/waivers.ts";
import type { Baseline } from "../scripts/parity/types.ts";
import { fromFileUrl } from "@std/path";
import { watchTests } from "./helpers/watchdog.ts";

// The surface extraction runs `deno doc` children from this process, one per catalog module,
// serially: a stall (CI windows-tests, runtime 3.0.0-rc.5) fails it at the deadline, naming the
// `deno doc` it waits on, instead of holding the CI job. About 20 s on a healthy runner but more
// than 10 minutes on a machine at load 400, so the deadline is 30 minutes rather than the default.
watchTests(1_800_000);

const ROOT = fromFileUrl(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const LEDGER = `${ROOT}/tests/fixtures/react-parity-known-gaps.json`;

interface Ledger {
  gaps: { specifier: string; symbol: string; category: string }[];
}

async function loadBaseline(): Promise<Baseline> {
  // The React/Next baseline plus the Preact one (tests/fixtures/preact-surface.baseline.json).
  return await readBaselines(ROOT);
}

async function loadKnownGaps(): Promise<Set<string>> {
  const ledger = JSON.parse(await Deno.readTextFile(LEDGER)) as Ledger;
  // deno-lint-ignore no-explicit-any
  return new Set(ledger.gaps.map((g) => findingKey(g.specifier, g.symbol, g.category as any)));
}

Deno.test("parity: catalog matches deno.json exports", async () => {
  await assertCatalogMatchesExports(ROOT);
});

Deno.test("parity: baseline is present and non-trivial", async () => {
  const b = await loadBaseline();
  const total = b.surfaces.reduce((n, s) => n + Object.keys(s.symbols).length, 0);
  assert(total > 500, `baseline looks empty (${total} symbols) — run \`deno task parity:refresh\``);
  assert(
    b.versions.react?.startsWith("19"),
    `unexpected React version in baseline: ${b.versions.react}`,
  );
  // The version the compat modules REPORT is the version whose surface they mirror.
  assertEquals(
    REACT_COMPAT_VERSION,
    b.versions.react,
    "src/compat/react-version.ts must track the parity baseline (deno task parity:refresh)",
  );
});

// One sub-test per package family so a failure points at the exact surface.
const GROUPS = [...new Set(CATALOG.map((e) => e.group))];

Deno.test("parity: denext surface matches React/ReactDOM/Next", async (t) => {
  const baseline = await loadBaseline();
  const knownGaps = await loadKnownGaps();
  const denext = await extractDenextSurfaces(ROOT);

  for (const group of GROUPS) {
    await t.step(group, () => {
      const specs = new Set(CATALOG.filter((e) => e.group === group).map((e) => e.specifier));
      const real = baseline.surfaces.filter((s) => specs.has(s.specifier));
      const den = denext.filter((s) => specs.has(s.specifier));
      const result = diffSurfaces(real, den, WAIVERS, knownGaps);
      // Fails only on a NEW deviation (one not intentionally waived and not in the
      // known-gaps ledger). Close a gap → prune the ledger with `deno task parity:gaps`.
      assert(result.ok, "\n" + formatReport(result));
    });
  }
});

Deno.test("parity: a deno doc past its deadline is killed and named, not awaited forever", async () => {
  const file = `${ROOT}/src/compat/react-version.ts`;
  // A child that can't finish in time: it beats a heartbeat file until killed. A real `deno doc`
  // with a 1 ms deadline raced it, and lost whenever the thread was held between the spawn and the
  // timer for longer than the `deno doc` ran (a CI macos-tests failure).
  const beat = await Deno.makeTempFile({ prefix: "denext-parity-beat-" });
  try {
    const stub = `let n = 0; setInterval(() => Deno.writeTextFileSync(${
      JSON.stringify(beat)
    }, String(++n)), 25);`;
    const err = await assertRejects(() => docFor(file, 1_500, ["eval", stub]), Error);
    assert(/^deno doc \(pid \d+\) still running after 1500 ms: /.test(err.message), err.message);
    // Killed, not left running: the heartbeat stops.
    await new Promise((r) => setTimeout(r, 500));
    const before = await Deno.readTextFile(beat);
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(await Deno.readTextFile(beat), before, "the timed-out child is still running");
  } finally {
    await Deno.remove(beat).catch(() => {});
  }
  // With room to finish it reads the module's symbols.
  const syms = await docFor(file);
  assert(syms.some((s: { name?: string }) => s.name === "REACT_COMPAT_VERSION"));
});
