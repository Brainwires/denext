// denext.config key checks: the "unknown option" warnings (with a "did you mean" hint) for the
// top level and `experimental.*`, and the error for a removed `experimental.*` key.

import { CONFIG_KEYS, EXPERIMENTAL_KEYS } from "../config-keys.generated.ts";
import { editDistance } from "../../utils/edit-distance.ts";
import type { Fail } from "./shared.ts";

/**
 * The recognized top-level {@link DenextConfig} keys — the generated
 * {@link CONFIG_KEYS} list (derived from the interface by `deno task gen:config-schema`,
 * so it cannot drift from the type). `warnUnknownConfigKeys` flags anything outside this
 * set, since the loader copies exactly these fields and would drop an unknown key silently.
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = CONFIG_KEYS;

/** The recognized `experimental.*` sub-keys (generated from `ExperimentalConfig`). */
const KNOWN_EXPERIMENTAL_KEYS: readonly string[] = EXPERIMENTAL_KEYS;

/**
 * The closest key in `known` to `key` within a small edit distance (case-insensitive), or
 * `undefined` when nothing is near enough to suggest. Used for "did you mean" hints; the
 * candidate list defaults to the top-level {@link KNOWN_CONFIG_KEYS}.
 */
export function didYouMean(
  key: string,
  known: readonly string[] = KNOWN_CONFIG_KEYS,
): string | undefined {
  const lower = key.toLowerCase();
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  // Only suggest when the typo is close: within a third of the key's length (min 2).
  return best !== undefined && bestDist <= Math.max(2, Math.floor(key.length / 3))
    ? best
    : undefined;
}

/** The "unknown option" warning line, with a suggestion when a close known key exists. */
export function unknownKeyMessage(
  name: string,
  key: string,
  suggestion: string | undefined,
): string {
  return `denext: ${name} has an unknown option \`${key}\`, which will be ignored` +
    (suggestion ? ` — did you mean \`${suggestion}\`?` : ".");
}

/**
 * `experimental.*` keys that graduated to top-level config, with whether the old alias is
 * still read. Setting one gets a "moved" message instead of a generic unknown-key warning.
 * The honored ones are Next.js's own spellings, kept as obsolete aliases for migrated Next
 * apps (and so still `ExperimentalConfig` members); this map is consulted before the
 * generated key list, so it warns either way.
 */
const MOVED_EXPERIMENTAL_KEYS: ReadonlyMap<string, { to: string; honored: boolean }> = new Map([
  ["streaming", { to: "streaming", honored: false }], // alias removed in 2.0
  ["live", { to: "live", honored: false }], // alias removed in 2.0
  ["cacheComponents", { to: "cacheComponents", honored: true }], // Next 16's spelling
  ["reactCompiler", { to: "reactCompiler", honored: true }], // Next 15's spelling
  ["optimizePackageImports", { to: "optimizePackageImports", honored: true }], // Next's spelling
]);

/**
 * denext's own former `experimental.*` keys, removed in 3.0, mapped to the top-level key that
 * replaces each. Setting one is a validation ERROR, not a warning: silently ignoring, say,
 * `experimental.nodeResolve: false` would change how the app builds.
 */
const REMOVED_EXPERIMENTAL_KEYS: ReadonlyMap<string, string> = new Map([
  ["compiler", "reactCompiler"],
  ["asyncContext", "asyncContext"],
  ["features", "features"],
  ["nodeResolve", "nodeResolve"],
]);

/**
 * Top-level keys denext renamed, mapped to the key that replaces each. Setting one is a
 * validation ERROR naming the new key — never a silently dropped field and never an alias.
 * denext 4.0 renamed background/scheduled "tasks" to "jobs" (`denext task` is Deno's now).
 */
const REMOVED_CONFIG_KEYS: ReadonlyMap<string, string> = new Map([
  ["tasks", "jobs"],
  ["scheduledTasks", "scheduledJobs"],
]);

/** The warning for a graduated `experimental.<key>`, pointing at its top-level home. */
function movedKeyMessage(name: string, key: string, to: string, honored: boolean): string {
  const status = honored ? "is still honored for now but has moved" : "is no longer honored";
  return `denext: ${name} sets \`experimental.${key}\`, which ${status} — set top-level \`${to}\` instead.`;
}

/**
 * One level down: a "moved" pointer for every graduated `experimental.*` key, and an
 * unknown-key warning for anything outside the generated `EXPERIMENTAL_KEYS`.
 */
function warnUnknownExperimentalKeys(experimental: unknown, name: string): void {
  if (typeof experimental !== "object" || experimental === null || Array.isArray(experimental)) {
    return;
  }
  for (const key of Object.keys(experimental)) {
    if (REMOVED_EXPERIMENTAL_KEYS.has(key)) continue; // a validation error, not a warning
    const moved = MOVED_EXPERIMENTAL_KEYS.get(key);
    if (moved) {
      console.warn(movedKeyMessage(name, key, moved.to, moved.honored));
      continue;
    }
    if (KNOWN_EXPERIMENTAL_KEYS.includes(key)) continue;
    const suggestion = didYouMean(key, KNOWN_EXPERIMENTAL_KEYS);
    console.warn(unknownKeyMessage(name, `experimental.${key}`, suggestion));
  }
}

/**
 * Warn (to stderr, never throw) on any top-level config key not in {@link KNOWN_CONFIG_KEYS},
 * and one level down on any `experimental.*` key not in the generated `EXPERIMENTAL_KEYS`.
 * The loader reconstructs config from a fixed field list, so an unrecognized key (a typo,
 * a stale Next.js option) is otherwise dropped with no signal. Emits a "did you mean"
 * suggestion when a close known key exists, and a "moved to top-level" pointer for every
 * graduated `experimental.*` key (see `MOVED_EXPERIMENTAL_KEYS`).
 *
 * @param config The raw config object as authored (before the loader's whitelist).
 * @param name The config file name, for the message (default `"denext.config"`).
 */
export function warnUnknownConfigKeys(config: object, name = "denext.config"): void {
  for (const key of Object.keys(config)) {
    if (KNOWN_CONFIG_KEYS.includes(key)) continue;
    if (REMOVED_CONFIG_KEYS.has(key)) continue; // a validation error, not a warning
    console.warn(unknownKeyMessage(name, key, didYouMean(key)));
  }
  warnUnknownExperimentalKeys((config as { experimental?: unknown }).experimental, name);
}

/** A removed denext `experimental.*` key fails, naming the top-level key that replaced it. */
export function validateRemovedExperimental(experimental: unknown, fail: Fail): void {
  if (typeof experimental !== "object" || experimental === null) return;
  for (const [key, to] of REMOVED_EXPERIMENTAL_KEYS) {
    if (Object.hasOwn(experimental, key)) {
      fail(`experimental.${key}`, `was removed in denext 3.0 — set top-level \`${to}\` instead`);
    }
  }
}

/**
 * A renamed top-level key ({@linkcode REMOVED_CONFIG_KEYS}) fails, naming the key that replaced
 * it. Checked on the config as authored — the loader's field whitelist would drop it otherwise.
 *
 * @param config The raw config object (a default export, or a module's named exports).
 * @param fail The field-scoped failure.
 */
export function validateRemovedConfigKeys(config: object, fail: Fail): void {
  for (const [key, to] of REMOVED_CONFIG_KEYS) {
    if (Object.hasOwn(config, key)) {
      fail(
        key,
        `was renamed in denext 4.0 — use \`${to}\` instead (background work is "jobs" now)`,
      );
    }
  }
}
