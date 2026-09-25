// Regenerate the native known-gaps ledger: the REAL, currently-unclosed deviations
// between denext's react-native / expo surface and the committed baselines (after the
// intentional-policy waivers in `waivers.ts`). The mobile-side twin of
// `../write-known-gaps.ts`.
//
//   deno task parity:native:gaps                 # both targets (react-native needs npm)
//   deno task parity:native:gaps -- expo         # recompute only expo gaps (offline)
//   deno task parity:native:gaps -- --offline    # keep react-native gaps, recompute expo
//
// The gate (`check.ts`) tolerates exactly these entries and fails on any NEW deviation, so
// the ledger is a burn-down baseline (like a lint baseline), NOT a list of intentional
// differences — shrinking it is the parity roadmap. Recomputing a subset preserves the
// other target's existing entries.

import { diffSurfaces, type Finding } from "../diff.ts";
import type { Baseline, Surface } from "../types.ts";
import { rnwRuntimeSurface } from "./runtime.ts";
import { expoParitySetup, parseNativeArgs } from "./shared.ts";
import { NATIVE_WAIVERS } from "./waivers.ts";
import {
  expoBaselinePath,
  knownGapsPath,
  loadExpoShims,
  REACT_NATIVE_SPECIFIER,
  rnBaselinePath,
} from "./spec.ts";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const LEDGER = knownGapsPath(ROOT);

interface Gap {
  specifier: string;
  symbol: string;
  category: string;
  detail: string;
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

const toGaps = (errors: Finding[]): Gap[] =>
  errors.map((f) => ({
    specifier: f.specifier,
    symbol: f.symbol,
    category: f.category,
    detail: f.detail,
  }));

async function reactNativeGaps(): Promise<Gap[]> {
  const baseline = await loadJson<Baseline>(rnBaselinePath(ROOT));
  if (!baseline) {
    console.error(
      "react-native baseline missing; run `parity:native:refresh -- react-native` first.",
    );
    return [];
  }
  // EXPECTED = the committed react-native `.d.ts` baseline; ACTUAL = react-native-web's live
  // runtime keys. No npm install needed — only the react-native-web runtime import.
  const actual = await rnwRuntimeSurface(REACT_NATIVE_SPECIFIER);
  return toGaps(diffSurfaces(baseline.surfaces, [actual], NATIVE_WAIVERS).errors);
}

// fallow-ignore-next-line complexity -- CLI gaps-writer script; not unit-tested, CRAP is coverage-estimated
async function expoGaps(): Promise<Gap[]> {
  const shims = await loadExpoShims(ROOT);
  if (!shims || Object.keys(shims).length === 0) return [];
  const baseline = await loadJson<Baseline>(expoBaselinePath(ROOT));
  if (!baseline) {
    console.error("expo baseline missing; run `parity:native:refresh -- expo` first.");
    return [];
  }
  const { baseBySpec, denext } = await expoParitySetup(ROOT, baseline, shims);
  const real: Surface[] = [];
  const den: Surface[] = [];
  for (const [key, shim] of Object.entries(shims)) {
    const base = baseBySpec.get(key);
    if (!base) continue;
    const drop = new Set(shim.omitted ?? []);
    real.push({
      ...base,
      symbols: Object.fromEntries(Object.entries(base.symbols).filter(([n]) => !drop.has(n))),
    });
    den.push(
      denext.find((s) => s.specifier === key) ?? { specifier: key, resolved: true, symbols: {} },
    );
  }
  return toGaps(diffSurfaces(real, den, NATIVE_WAIVERS).errors);
}

// fallow-ignore-next-line complexity -- CLI entrypoint; not unit-tested, CRAP is coverage-estimated
async function main() {
  const { offline, only } = parseNativeArgs();
  const doRn = !offline && (only.length === 0 || only.includes("react-native"));
  const doExpo = only.length === 0 || only.includes("expo");

  const existing = (await loadJson<{ gaps: Gap[] }>(LEDGER))?.gaps ?? [];
  const keptRn = doRn ? [] : existing.filter((g) => g.specifier === REACT_NATIVE_SPECIFIER);
  const keptExpo = doExpo ? [] : existing.filter((g) => g.specifier !== REACT_NATIVE_SPECIFIER);

  const gaps = [
    ...keptRn,
    ...keptExpo,
    ...(doRn ? await reactNativeGaps() : []),
    ...(doExpo ? await expoGaps() : []),
  ].sort((a, b) =>
    (a.specifier + a.symbol + a.category).localeCompare(b.specifier + b.symbol + b.category)
  );

  await Deno.mkdir(LEDGER.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(
    LEDGER,
    JSON.stringify(
      {
        note: "Real, currently-open native (react-native / expo) signature deviations. Burn this " +
          "down; `deno task parity:native` fails on any deviation NOT listed here. Regenerate " +
          "with `deno task parity:native:gaps`.",
        gaps,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${gaps.length} native known gap(s) → ${LEDGER}`);
}

if (import.meta.main) await main();
