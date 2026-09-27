// The native signature-parity GATE (`deno task parity:native`): denext's React Native and Expo
// compat surface against the pinned real packages, failing only on a deviation that is neither
// an intentional waiver (`waivers.ts`) nor in the known-gaps ledger (`baselines/known-gaps.json`).
//
//   deno task parity:native                    # both targets
//   deno task parity:native -- react-native    # react-native target only
//   deno task parity:native -- expo            # expo target only
//   deno task parity:native -- lists           # the list adapters only (offline; see lists.ts)
//   deno task parity:native -- desktop         # react-native-windows / -macos aliases (desktop.ts)
//   deno task parity:native -- --offline       # skip the react-native runtime import
//
// Two targets:
//
//   • react-native — NAMES + MEMBERS. EXPECTED: the export names (and object members / class
//     statics) of the pinned `react-native` package's own `.d.ts`, frozen in
//     `baselines/react-native.baseline.json`. ACTUAL: the bundle an app gets — `export * from
//     "react-native"` built with React Native mode's own plugins (`reactNativeBundleOptions`)
//     over the pinned `react-native-web`, its export names from the build's metafile and each
//     export's members from running it (`bundle.ts`; needs Deno's npm cache or the network, or
//     `--offline` to skip). A runtime value react-native declares that the bundle does not
//     export is an error, as is a missing member (MEMBER_MISSING); a missing type-only export
//     is a warning. No arity diff: react-native-web ships no types.
//     The shell overlay check then requires every API react-native-web ships as a mock to be
//     backed by React Native mode's overlay (`RN_OVERLAY_EXPORTS`, `src/react-native/`).
//   • expo — each `denext/expo/*` shim in `src/expo/manifest.ts` (`deno doc` over its source,
//     offline) against its package's pinned `.d.ts` surface, frozen in
//     `baselines/expo.baseline.json`, minus the shim's `omitted` list: names, value-ness,
//     arity and object members. A shim whose pin differs from the captured version is skipped
//     until `deno task parity:native:refresh -- expo` recaptures it.
//
// Exit code: 0 on pass, 1 on any unexplained deviation.

import { type Category, diffSurfaces, findingKey, formatReport } from "../diff.ts";
import type { Baseline, Surface } from "../types.ts";
import { rnBundleSurface } from "./bundle.ts";
import { expoParitySetup, parseNativeArgs } from "./shared.ts";
import { NATIVE_WAIVERS } from "./waivers.ts";
import {
  expoBaselinePath,
  expoPackageOf,
  type ExpoShims,
  knownGapsPath,
  loadExpoShims,
  REACT_NATIVE_PACKAGE,
  REACT_NATIVE_SPECIFIER,
  REACT_NATIVE_WEB_MOCKS,
  REACT_NATIVE_WEB_PACKAGE,
  REACT_NATIVE_WEB_PIN,
  rnBaselinePath,
} from "./spec.ts";
import { RN_OVERLAY_EXPORTS } from "../../../src/build/react-native.ts";
import { checkLists } from "./lists.ts";
import { checkDesktop } from "./desktop.ts";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

interface Ledger {
  gaps: { specifier: string; symbol: string; category: string }[];
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

async function loadKnownGaps(): Promise<Set<string>> {
  const ledger = await loadJson<Ledger>(knownGapsPath(ROOT));
  return new Set(
    (ledger?.gaps ?? []).map((g) => findingKey(g.specifier, g.symbol, g.category as Category)),
  );
}

/** A copy of `surface` with the named symbols removed (the shim's `omitted` list). */
function withoutSymbols(surface: Surface, omit: readonly string[]): Surface {
  if (omit.length === 0) return surface;
  const drop = new Set(omit);
  const symbols = Object.fromEntries(
    Object.entries(surface.symbols).filter(([name]) => !drop.has(name)),
  );
  return { ...surface, symbols };
}

// react-native target: names + members. EXPECTED = the committed react-native `.d.ts`
// baseline; ACTUAL = the React Native mode bundle's exports and their runtime members. A
// runtime value react-native declares but the bundle does not export is a MISSING_VALUE error,
// a member it lacks a MEMBER_MISSING error; type-only exports are non-blocking warnings.
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
async function checkReactNative(offline: boolean, knownGaps: Set<string>): Promise<boolean> {
  const baseline = await loadJson<Baseline>(rnBaselinePath(ROOT));
  if (!baseline) {
    console.log(
      "react-native: baseline missing; run `deno task parity:native:refresh -- react-native`. Skipped.",
    );
    return true;
  }
  if (offline) {
    console.log("react-native: --offline; skipped the live react-native-web runtime import.");
    return true;
  }
  console.error(
    `react-native: bundling "react-native" through React Native mode over ` +
      `${REACT_NATIVE_WEB_PACKAGE}@${REACT_NATIVE_WEB_PIN} …`,
  );
  const { surface: actual, bytes } = await rnBundleSurface(ROOT, REACT_NATIVE_SPECIFIER);
  const result = diffSurfaces(baseline.surfaces, [actual], NATIVE_WAIVERS, knownGaps);
  console.log(
    `\n== react-native (NAMES + MEMBERS: ${REACT_NATIVE_PACKAGE} ${
      baseline.versions[REACT_NATIVE_PACKAGE]
    } expected exports vs the React Native mode bundle over ${REACT_NATIVE_WEB_PACKAGE} ` +
      `${REACT_NATIVE_WEB_PIN}; no arity diff — react-native-web ships no TS types) ==`,
  );
  console.log(
    `  react-native expected: ${
      Object.keys(baseline.surfaces[0]?.symbols ?? {}).length
    } names; React Native mode bundle: ${Object.keys(actual.symbols).length} exports ` +
      `(${Math.round(bytes / 1024)} KiB unminified)`,
  );
  console.log(formatReport(result));
  return result.ok;
}

/**
 * react-native-web's mocks vs React Native mode's shell overlay: every API react-native-web ships
 * as a mock (or leaves unstarted) must be one the overlay replaces, and the overlay module
 * (`src/react-native/mod.ts`) must export it (a component as `create<Name>`). Offline.
 */
async function checkShellOverlay(): Promise<boolean> {
  const overlay = await import("../../../src/react-native/mod.ts") as Record<string, unknown>;
  const backed = (name: string) => {
    const kind = RN_OVERLAY_EXPORTS[name];
    if (kind === undefined) return false;
    return overlay[kind === "view" ? `create${name}` : name] !== undefined;
  };
  const mocked = REACT_NATIVE_WEB_MOCKS.filter((name) => !backed(name));
  const extra = Object.keys(RN_OVERLAY_EXPORTS).filter((n) => !REACT_NATIVE_WEB_MOCKS.includes(n));
  const unexported = extra.filter((name) => !backed(name));
  console.log(
    `\n== react-native shell overlay (react-native-web mocks → denext implementations) ==`,
  );
  console.log(
    `  mocked in react-native-web: ${REACT_NATIVE_WEB_MOCKS.length}; backed by denext: ${
      REACT_NATIVE_WEB_MOCKS.length - mocked.length
    }; also replaced (browser-only in react-native-web): ${extra.join(", ")}`,
  );
  for (const name of mocked) console.log(`  ✗ ${name}: still react-native-web's mock`);
  for (const name of unexported) console.log(`  ✗ ${name}: listed but not exported by the overlay`);
  return mocked.length === 0 && unexported.length === 0;
}

/** expo target: each denext shim vs its frozen `expo-*` baseline minus `omitted`. */
// fallow-ignore-next-line complexity -- CLI parity-report script; not unit-tested, CRAP is coverage-estimated
async function checkExpo(knownGaps: Set<string>): Promise<boolean> {
  const shims: ExpoShims | null = await loadExpoShims(ROOT);
  if (!shims || Object.keys(shims).length === 0) {
    console.log("expo: manifest not found; expo parity skipped.");
    return true;
  }
  const baseline = await loadJson<Baseline>(expoBaselinePath(ROOT));
  if (!baseline) {
    console.log(
      "expo: manifest present but baseline missing; run `deno task parity:native:refresh -- expo`. Skipped.",
    );
    return true;
  }
  const { baseBySpec, denext } = await expoParitySetup(ROOT, baseline, shims);

  // Build the real side: each shim's baseline surface minus its `omitted` list. Skip a shim
  // whose pinned version no longer matches the captured baseline (needs a refresh) — a
  // green skip with a clear message, so a pin bump never blocks before the baseline moves.
  const realSurfaces: Surface[] = [];
  const denSurfaces: Surface[] = [];
  for (const [key, shim] of Object.entries(shims)) {
    const base = baseBySpec.get(key);
    if (!base) {
      console.log(
        `expo ${key}: no baseline surface; run \`parity:native:refresh -- expo\`. Skipped.`,
      );
      continue;
    }
    const captured = baseline.versions[expoPackageOf(key)];
    if (captured && captured !== shim.pinned) {
      console.log(
        `expo ${key}: manifest pins ${shim.pinned} but baseline captured ${captured}; ` +
          "run `parity:native:refresh -- expo`. Skipped.",
      );
      continue;
    }
    realSurfaces.push(withoutSymbols(base, shim.omitted ?? []));
    denSurfaces.push(
      denext.find((s) => s.specifier === key) ?? {
        specifier: key,
        resolved: true,
        symbols: {},
      },
    );
  }
  if (realSurfaces.length === 0) {
    console.log("expo: no comparable shims after version/baseline checks; skipped.");
    return true;
  }
  const result = diffSurfaces(realSurfaces, denSurfaces, NATIVE_WAIVERS, knownGaps);
  console.log(`\n== expo (${realSurfaces.length} shim(s)) ==`);
  console.log(formatReport(result));
  return result.ok;
}

// fallow-ignore-next-line complexity -- CLI entrypoint; not unit-tested, CRAP is coverage-estimated
async function main() {
  const { offline, only } = parseNativeArgs();
  const doRn = only.length === 0 || only.includes("react-native");
  const doExpo = only.length === 0 || only.includes("expo");

  const knownGaps = await loadKnownGaps();
  let ok = true;
  if (doRn) ok = (await checkReactNative(offline, knownGaps)) && ok;
  if (doRn) ok = (await checkShellOverlay()) && ok;
  if (doExpo) ok = (await checkExpo(knownGaps)) && ok;
  if (only.length === 0 || only.includes("lists")) ok = (await checkLists(ROOT)) && ok;
  if ((only.length === 0 || only.includes("desktop")) && !offline) {
    ok = (await checkDesktop(ROOT, knownGaps)) && ok;
  }

  if (!ok) {
    console.error(
      "\nnative parity FAILED — a new deviation is neither waived nor in the ledger. " +
        "Fix the shim, add a waiver (scripts/parity/native/waivers.ts), or accept it with " +
        "`deno task parity:native:gaps`.",
    );
    Deno.exit(1);
  }
  console.log("\nnative parity: PASS");
}

if (import.meta.main) await main();
