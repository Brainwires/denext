// The React Native desktop target of the native parity gate: `react-native-windows` and
// `react-native-macos`, each as React Native mode aliases it (src/build/react-native-desktop.ts,
// manifest src/react-native/desktop-manifest.ts).
//
//   EXPECTED: the pinned package's own `.d.ts` export names and members, frozen in
//             `baselines/react-native-desktop.baseline.json` (`parity:native:refresh -- desktop`).
//   ACTUAL:   the bundle an app gets for `export * from "<package>"` built with React Native
//             mode's plugins (bundle.ts), names from the metafile and members from running it.
//
// Findings not in the manifest's `omitted` list and not in the known-gaps ledger fail the gate.
// Most of each package's surface is React Native's own, so its gaps mirror the react-native
// target's (the `*Base` / `*Component` aliases, DrawerLayoutAndroid, …).

import { diffSurfaces, type Finding, formatReport } from "../diff.ts";
import type { Baseline, Surface } from "../types.ts";
import { DESKTOP_ALIASES } from "../../../src/react-native/desktop-manifest.ts";
import { rnBundleSurface } from "./bundle.ts";
import { captureReal } from "./capture.ts";
import { desktopBaselinePath } from "./spec.ts";
import { NATIVE_WAIVERS } from "./waivers.ts";

/** The desktop packages the gate covers (the manifest's keys). */
export function desktopPackages(): string[] {
  return Object.keys(DESKTOP_ALIASES);
}

/** Read a JSON file, or null. */
async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

/** `surface` without the manifest's whole-export `omitted` names (member ones stay). */
function withoutOmitted(surface: Surface): Surface {
  const omitted = new Set(
    (DESKTOP_ALIASES[surface.specifier]?.omitted ?? []).filter((n) => !n.includes(".")),
  );
  if (omitted.size === 0) return surface;
  return {
    ...surface,
    symbols: Object.fromEntries(
      Object.entries(surface.symbols).filter(([name]) => !omitted.has(name)),
    ),
  };
}

/** Whether `surface` was captured from another version than the manifest pins. */
function stale(baseline: Baseline, surface: Surface): boolean {
  const pinned = DESKTOP_ALIASES[surface.specifier]?.pinned;
  return pinned !== undefined && (baseline.versions[surface.specifier] ?? pinned) !== pinned;
}

/** The baseline surfaces whose captured version matches the manifest's pin. */
function comparable(baseline: Baseline): Surface[] {
  const fresh: Surface[] = [];
  for (const surface of baseline.surfaces) {
    if (!stale(baseline, surface)) fresh.push(withoutOmitted(surface));
    else {
      console.log(
        `desktop ${surface.specifier}: the baseline predates the manifest's pin; ` +
          "run `parity:native:refresh -- desktop`. Skipped.",
      );
    }
  }
  return fresh;
}

/** The React Native mode bundle surfaces of `specifiers`. */
async function actualSurfaces(root: string, specifiers: string[]): Promise<Surface[]> {
  const out: Surface[] = [];
  for (const spec of specifiers) out.push((await rnBundleSurface(root, spec)).surface);
  return out;
}

/** The diff of the desktop packages, or null when there is no baseline yet. */
async function diffDesktop(root: string, knownGaps?: Set<string>) {
  const baseline = await loadJson<Baseline>(desktopBaselinePath(root));
  if (!baseline) {
    console.log(
      "desktop: baseline missing; run `deno task parity:native:refresh -- desktop`. Skipped.",
    );
    return null;
  }
  const expected = comparable(baseline);
  const actual = await actualSurfaces(root, expected.map((s) => s.specifier));
  return diffSurfaces(expected, actual, NATIVE_WAIVERS, knownGaps);
}

/**
 * The desktop gate: each package's expected surface against React Native mode's bundle.
 *
 * @param root The framework root.
 * @param knownGaps The ledger's finding keys.
 * @returns Whether it passed.
 */
export async function checkDesktop(root: string, knownGaps: Set<string>): Promise<boolean> {
  const result = await diffDesktop(root, knownGaps);
  if (!result) return true;
  console.log(
    `\n== react-native desktop (${desktopPackages().join(", ")} vs React Native mode's aliases) ==`,
  );
  console.log(formatReport(result));
  return result.ok;
}

/**
 * The desktop packages' current, unwaived deviations, for the known-gaps ledger.
 *
 * @param root The framework root.
 * @returns The findings.
 */
export async function desktopGaps(root: string): Promise<Finding[]> {
  return (await diffDesktop(root))?.errors ?? [];
}

/**
 * Capture the pinned desktop packages' `.d.ts` surfaces into the baseline.
 *
 * @param root The framework root.
 */
export async function refreshDesktop(root: string): Promise<void> {
  const deps = Object.fromEntries(
    Object.entries(DESKTOP_ALIASES).map(([pkg, alias]) => [pkg, alias.pinned]),
  );
  console.error(
    `installing ${Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(", ")} (EXPECTED) …`,
  );
  const packages = desktopPackages();
  const captured = await captureReal(
    deps,
    packages.map((pkg) => ({ specifier: pkg, real: pkg })),
    packages,
  );
  const baseline: Baseline = {
    versions: captured.versions,
    capturedAt: new Date().toISOString(),
    surfaces: captured.surfaces,
  };
  await Deno.writeTextFile(desktopBaselinePath(root), JSON.stringify(baseline, null, 2) + "\n");
  console.log(
    `wrote desktop baseline: ${
      captured.surfaces.map((s) => `${s.specifier} ${Object.keys(s.symbols).length}`).join(", ")
    } → ${desktopBaselinePath(root)}`,
  );
}
