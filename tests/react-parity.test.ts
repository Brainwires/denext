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

import { assert } from "@std/assert";
import { assertCatalogMatchesExports, CATALOG } from "../scripts/parity/spec.ts";
import { extractDenextSurfaces } from "../scripts/parity/extract-denext.ts";
import { diffSurfaces, findingKey, formatReport } from "../scripts/parity/diff.ts";
import { WAIVERS } from "../scripts/parity/waivers.ts";
import type { Baseline } from "../scripts/parity/types.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const BASELINE = `${ROOT}/tests/fixtures/react-surface.baseline.json`;
const LEDGER = `${ROOT}/tests/fixtures/react-parity-known-gaps.json`;

interface Ledger {
  gaps: { specifier: string; symbol: string; category: string }[];
}

async function loadBaseline(): Promise<Baseline> {
  return JSON.parse(await Deno.readTextFile(BASELINE)) as Baseline;
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
