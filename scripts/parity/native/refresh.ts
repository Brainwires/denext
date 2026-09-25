// Refresh the native parity baselines: the frozen real-side snapshots the gate
// (`check.ts`) diffs denext against. The mobile-side twin of `../refresh.ts`.
//
//   deno task parity:native:refresh                 # both targets (expo only if manifest present)
//   deno task parity:native:refresh -- react-native # react-native-web baseline only
//   deno task parity:native:refresh -- expo         # expo baseline only (needs the manifest)
//
// Writes:
//   scripts/parity/native/baselines/react-native.baseline.json
//   scripts/parity/native/baselines/expo.baseline.json  (only when src/expo/manifest.ts exists)
//
// This is the accept-baseline path — run it after deliberately pinning/upgrading
// react-native-web or an expo shim, review the diff, then run `parity:native:gaps`.

import type { Baseline } from "../types.ts";
import { captureReal } from "./capture.ts";
import { countSurfaceSymbols } from "./shared.ts";
import {
  expoBaselinePath,
  expoInstallDeps,
  expoPackages,
  expoRealTargets,
  loadExpoShims,
  REACT_NATIVE_EXPECTED_PACKAGES,
  REACT_NATIVE_EXPECTED_TARGET,
  REACT_NATIVE_PACKAGE,
  REACT_NATIVE_PIN,
  reactNativeExpectedDeps,
  rnBaselinePath,
} from "./spec.ts";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

async function writeBaseline(path: string, captured: Baseline): Promise<void> {
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(captured, null, 2) + "\n");
}

// EXPECTED surface: the `react-native` package's own bundled `.d.ts` export names, pinned
// to T3's version. The ACTUAL side (react-native-web runtime keys) is computed live by the
// gate, so nothing about react-native-web is captured here.
async function refreshReactNative(): Promise<void> {
  console.error(`installing ${REACT_NATIVE_PACKAGE}@${REACT_NATIVE_PIN} (EXPECTED surface) …`);
  const captured = await captureReal(
    reactNativeExpectedDeps(),
    [REACT_NATIVE_EXPECTED_TARGET],
    REACT_NATIVE_EXPECTED_PACKAGES,
  );
  const baseline: Baseline = {
    versions: captured.versions,
    capturedAt: new Date().toISOString(),
    surfaces: captured.surfaces,
  };
  await writeBaseline(rnBaselinePath(ROOT), baseline);
  const syms = countSurfaceSymbols(captured.surfaces);
  console.log(
    `wrote react-native baseline: ${syms} expected export names (react-native ${
      captured.versions[REACT_NATIVE_PACKAGE]
    }) → ${rnBaselinePath(ROOT)}`,
  );
}

async function refreshExpo(): Promise<void> {
  const shims = await loadExpoShims(ROOT);
  if (!shims || Object.keys(shims).length === 0) {
    console.log("expo: manifest not found (or empty); expo baseline skipped.");
    return;
  }
  const deps = expoInstallDeps(shims);
  console.error(
    `installing expo shims: ${Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(", ")} …`,
  );
  const captured = await captureReal(deps, expoRealTargets(shims), expoPackages(shims));
  const baseline: Baseline = {
    versions: captured.versions,
    capturedAt: new Date().toISOString(),
    surfaces: captured.surfaces,
  };
  await writeBaseline(expoBaselinePath(ROOT), baseline);
  const syms = countSurfaceSymbols(captured.surfaces);
  console.log(
    `wrote expo baseline: ${syms} symbols across ${captured.surfaces.length} package(s) → ${
      expoBaselinePath(ROOT)
    }`,
  );
}

// fallow-ignore-next-line complexity -- CLI baseline-refresh entrypoint; not unit-tested, CRAP is coverage-estimated
async function main() {
  const args = Deno.args.filter((a) => a !== "--");
  const doRn = args.length === 0 || args.includes("react-native");
  const doExpo = args.length === 0 || args.includes("expo");
  if (doRn) await refreshReactNative();
  if (doExpo) await refreshExpo();
}

if (import.meta.main) await main();
