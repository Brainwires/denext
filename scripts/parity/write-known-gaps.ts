// Regenerate the known-gaps ledger: the set of REAL, currently-unclosed signature
// deviations between denext and the committed React/ReactDOM/Next baseline (after the
// intentional-policy waivers in `waivers.ts`).
//
//   deno task parity:gaps
//
// The parity TEST tolerates exactly these entries and fails on any NEW deviation, so
// the ledger is a burn-down baseline (like a lint baseline), NOT a list of intentional
// differences — shrinking it is the parity roadmap. Run this after deliberately
// implementing or accepting a deviation; review the diff before committing.
//
// Offline: it reuses the committed baseline + `deno doc` over `src/compat/**`.

import { extractDenextSurfaces } from "./extract-denext.ts";
import { diffSurfaces } from "./diff.ts";
import { WAIVERS } from "./waivers.ts";
import type { Baseline } from "./types.ts";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const LEDGER = `${ROOT}/tests/fixtures/react-parity-known-gaps.json`;

const baseline = JSON.parse(
  await Deno.readTextFile(`${ROOT}/tests/fixtures/react-surface.baseline.json`),
) as Baseline;
const denext = await extractDenextSurfaces(ROOT);
const result = diffSurfaces(baseline.surfaces, denext, WAIVERS);

const gaps = result.errors
  .map((f) => ({
    specifier: f.specifier,
    symbol: f.symbol,
    category: f.category,
    detail: f.detail,
  }))
  .sort((a, b) =>
    (a.specifier + a.symbol + a.category).localeCompare(b.specifier + b.symbol + b.category)
  );

await Deno.writeTextFile(
  LEDGER,
  JSON.stringify(
    {
      note: "Real, currently-open signature deviations vs React/ReactDOM/Next. Burn this down; " +
        "the parity test fails on any deviation NOT listed here. Regenerate with `deno task parity:gaps`.",
      baselineVersions: baseline.versions,
      gaps,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${gaps.length} known gap(s) → ${LEDGER}`);
