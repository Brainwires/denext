// The packaged app's launch policy in `laufey-launch.json`: whether the pinned Deno Desktop
// runtime's webview backend reads `"strictPolicy": true` (laufey refuses instead of allowing when
// a policy key is missing: no `bridgeOrigins` / `customSchemes` gives the bridge to no document,
// no `passkeyRpIds` refuses every passkey ceremony), and the relying parties a packaged app's
// native passkeys may name (`"passkeyRpIds"`, from `desktop.capabilities.passkeys.rpIds`).
//
// Kept apart from desktop-app-config.ts so `denext doctor` and the package scripts share one gate.

import { join } from "@std/path";
import pinJson from "./desktop-runtime-pin.json" with { type: "json" };
import { compareDenoVersions } from "./deno-version.ts";
import { readJson } from "./json-edit.ts";

/**
 * The first denext Deno Desktop runtime whose laufey reads `"strictPolicy"` (Brainwires/deno
 * DENEXT.md item 122; laufey `fix/rc7-lows`).
 *
 * The gate compares through `compareDenoVersions`, which needs the fork's rc → denext ordering
 * (`3.0.0-rc.*` < `3.0.0-denext.1` < `3.0.0-denext.2`; `feat/denext-version-order`). Until that
 * lands, plain semver sorts every `3.0.0-rc.N` ABOVE `3.0.0-denext.1` (`r` > `d`), so an rc runtime
 * reads as strict too: harmless (an older laufey reports the unknown key and ignores it), but the
 * ordering change is required before this gate means what it says.
 */
export const FIRST_STRICT_LAUNCH_RUNTIME = "3.0.0-denext.1";

/** Reads an environment variable. */
type EnvGet = (key: string) => string | undefined;

/** `Deno.env.get` that reads a denied variable as unset. */
const processEnv: EnvGet = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
};

/**
 * Whether the Deno Desktop runtime `version` reads the launch file's `"strictPolicy"` (from
 * {@linkcode FIRST_STRICT_LAUNCH_RUNTIME}). A version that does not parse does not.
 *
 * @param version A runtime version (`3.0.0-denext.N`, `3.0.0-rc.N`, `2.9.7-denext.N`).
 * @returns Whether to write `"strictPolicy": true`.
 */
export function supportsStrictLaunch(version: string): boolean {
  return compareDenoVersions(version, FIRST_STRICT_LAUNCH_RUNTIME) >= 0;
}

/**
 * Whether a package script in this process builds on a runtime with the strict launch policy:
 * denext's pinned runtime (not `DENEXT_DESKTOP_RUNTIME=stock`, not a local
 * `DENEXT_DESKTOP_RUNTIME_DIR` build of unknown version) at {@linkcode FIRST_STRICT_LAUNCH_RUNTIME}
 * or later.
 *
 * @param env Reads an environment variable (default `Deno.env.get`, a denied read as unset).
 * @param version The pinned runtime's version (default: the pin's).
 * @returns Whether the packaged launch file carries `"strictPolicy": true`.
 */
export function strictLaunchRuntime(
  env: EnvGet = processEnv,
  version: string = pinJson.version,
): boolean {
  const mode = (env("DENEXT_DESKTOP_RUNTIME") ?? "").trim().toLowerCase();
  if (mode === "stock" || env("DENEXT_DESKTOP_RUNTIME_DIR")) return false;
  return supportsStrictLaunch(version);
}

/**
 * The relying parties the packaged app's native passkeys may name
 * (`desktop.capabilities.passkeys.rpIds`, lowercased, de-duplicated), or `null` when the passkeys
 * capability is off. An enabled capability without a list (a bare `true`, which config validation
 * rejects) reads as `[]`: refuse every RP.
 *
 * @param config The project config.
 * @returns The RP IDs, or `null`.
 */
export function desktopPasskeyRpIds(config: unknown): string[] | null {
  const passkeys = (config as { desktop?: { capabilities?: { passkeys?: unknown } } } | undefined)
    ?.desktop?.capabilities?.passkeys;
  if (passkeys === undefined || passkeys === false || passkeys === null) return null;
  const raw = typeof passkeys === "object" ? (passkeys as { rpIds?: unknown }).rpIds : undefined;
  const out: string[] = [];
  for (const id of Array.isArray(raw) ? raw : []) {
    if (typeof id !== "string" || id === "") continue;
    const lower = id.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

/** The fix for a passkeys capability that lists no relying party. */
export const PASSKEY_RP_IDS_FIX =
  'list the relying parties in desktop.capabilities.passkeys = { rpIds: ["example.com"] } ' +
  "(`denext desktop add passkeys --rp-id example.com` writes it; or set passkeys: false)";

/** One gap in the packaged launch policy, with its fix. */
export interface LaunchPolicyProblem {
  readonly message: string;
  readonly fix: string;
}

/**
 * The project's parsed `deno.json` (else `deno.jsonc`), or `null` (none, or it does not parse).
 *
 * @param dir The project directory.
 * @returns The document.
 */
export async function readProjectDenoJson(dir: string): Promise<Record<string, unknown> | null> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    const text = await Deno.readTextFile(join(dir, name)).catch(() => null);
    if (text === null) continue;
    try {
      return readJson(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whether `dir` is a desktop project: a `desktop.ts` entry, or a `desktop` block in its deno.json
 * (else deno.jsonc).
 *
 * @param dir The project directory.
 * @returns Whether it has a desktop target.
 */
export async function isDesktopProject(dir: string): Promise<boolean> {
  if ((await Deno.stat(join(dir, "desktop.ts")).catch(() => null))?.isFile) return true;
  return (await readProjectDenoJson(dir))?.desktop !== undefined;
}

/** The package scripts a desktop scaffold writes, relative to the project. */
const PACKAGE_SCRIPTS = [
  "scripts/package-macos.ts",
  "scripts/package-linux.ts",
  "scripts/package-windows.ts",
];

/** What a current package script calls to write `laufey-launch.json`. */
const LAUNCH_WRITERS = /\b(?:writeLaufeyLaunchConfig|buildDesktopBundle)\b/;

/**
 * The project's package scripts that never write denext's `laufey-launch.json` (a script from
 * before the launch file, or a hand-edited one): their bundles ship `deno desktop`'s own launch
 * file, with no `passkeyRpIds` and no `strictPolicy`.
 *
 * @param dir The project directory.
 * @returns The scripts' paths relative to `dir` (empty when every present script writes it).
 */
export async function stalePackageScripts(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of PACKAGE_SCRIPTS) {
    const text = await Deno.readTextFile(join(dir, rel)).catch(() => null);
    if (text !== null && !LAUNCH_WRITERS.test(text)) out.push(rel);
  }
  return out;
}

/**
 * Why the packaged launch file would leave a policy unpinned or refuse every ceremony: a passkeys
 * capability with no RP ID (`passkeyRpIds` empty, so laufey refuses every ceremony with
 * `invalid_rp`), a `desktop.app.bridgeOrigins` that cannot be written (no `bridgeOrigins`: under
 * the strict policy the bridge then serves no document), and package scripts that do not write
 * denext's launch file at all ({@linkcode stalePackageScripts}).
 *
 * @param config The project config.
 * @param bridgeOrigins Computes the launch file's `bridgeOrigins` (throws on a bad entry).
 * @param staleScripts The project's stale package scripts (default none).
 * @returns The problems (empty when the launch policy is complete).
 */
export function launchPolicyProblems(
  config: unknown,
  bridgeOrigins: (config: unknown) => string[],
  staleScripts: readonly string[] = [],
): LaunchPolicyProblem[] {
  const problems: LaunchPolicyProblem[] = [];
  try {
    bridgeOrigins(config);
  } catch (err) {
    problems.push({
      message: `the packaged launch file would lack bridgeOrigins (${
        err instanceof Error ? err.message : String(err)
      }): under the strict launch policy the window's bridge then serves no document`,
      fix: "fix desktop.app.bridgeOrigins: origins, <scheme>://* or *",
    });
  }
  const rpIds = desktopPasskeyRpIds(config);
  if (rpIds !== null && rpIds.length === 0) {
    problems.push({
      message: "passkeys are enabled but the packaged launch file's passkeyRpIds would be empty: " +
        "every passkey ceremony is refused (invalid_rp), natively and failing closed",
      fix: PASSKEY_RP_IDS_FIX,
    });
  }
  if (staleScripts.length > 0) {
    problems.push({
      message:
        `${staleScripts.join(", ")} never write${
          staleScripts.length === 1 ? "s" : ""
        } denext's laufey-launch.json, so the packaged app lacks bridgeOrigins, passkeyRpIds ` +
        "and strictPolicy",
      fix: "denext desktop package --regenerate-scripts",
    });
  }
  return problems;
}
