// `denext create` / `migrate`: pin `@denext/*` versions Deno will resolve under the project's
// minimum dependency age, instead of exempting denext from the hold (see `dep-age.ts`).

import { type DepAgeRule, holdMessage, readProjectRule } from "./dep-age.ts";
import {
  applyUpgrade,
  type EligiblePlan,
  jsrLookups,
  planEligiblePins,
  type UpgradeLookups,
  type UpgradeStep,
} from "./upgrade.ts";

/** How long `create` / `migrate` wait for JSR's publish times before keeping their pins. */
const ELIGIBILITY_TIMEOUT_MS = 3000;

/** What {@link pinEligible} did. */
export interface EligibleOutcome {
  /** `false`: no version old enough exists; `error` says when one will be. */
  readonly ok: boolean;
  /** The config text to write (unchanged when nothing moved). */
  readonly text: string;
  /** The pins that moved (apply to another copy of the config with `applyUpgrade`). */
  readonly steps: readonly UpgradeStep[];
  /** One line per held version (and the offline warning). */
  readonly notes: readonly string[];
  /** Why nothing could be pinned. */
  readonly error?: string;
}

/** The injectable parts (tests). */
export interface EligibleOptions {
  /** The registry lookups (default: JSR, with {@link ELIGIBILITY_TIMEOUT_MS}). */
  readonly lookups?: UpgradeLookups;
  /** The rule (default: read from the project directory). */
  readonly rule?: DepAgeRule;
  /** The clock. */
  readonly now?: Date;
}

/** The warning when JSR can't be read: the pins stay, and Deno may still hold them. */
export function offlineNote(reason: string): string {
  return `${reason}, so the publish times of the pinned @denext/* versions are unknown; kept ` +
    `them as written. Deno holds a version published within your dependency-age window ` +
    `(Deno's default is two days) until it passes — run "denext upgrade" if resolution is held.`;
}

/**
 * Move the `@denext/*` pins in a generated config down to versions the dependency-age rule
 * lets in (see {@link planEligiblePins}).
 *
 * @param text The generated config text.
 * @param dir The project directory (its rule: `deno.json`, `.npmrc`, `DENEXT_MIN_DEP_AGE`).
 * @param opts Injected lookups, rule and clock.
 * @returns The text to write, the lines to print, or the error.
 */
export async function pinEligible(
  text: string,
  dir: string,
  opts: EligibleOptions = {},
): Promise<EligibleOutcome> {
  const now = opts.now ?? new Date();
  const rule = opts.rule ?? await readProjectRule(dir, now);
  const lookups = opts.lookups ?? jsrLookups({ timeoutMs: ELIGIBILITY_TIMEOUT_MS });
  const plan: EligiblePlan = await planEligiblePins(text, lookups, rule, now);
  if (!plan.ok) {
    return plan.offline
      ? { ok: true, text, steps: [], notes: [offlineNote(plan.reason)] }
      : { ok: false, text, steps: [], notes: [], error: plan.reason };
  }
  return {
    ok: true,
    text: plan.changed ? applyUpgrade(text, plan.steps) : text,
    steps: plan.steps.filter((s) => s.from !== s.to),
    notes: plan.held.map((h) => holdMessage(h.held, h.pinned, now)),
  };
}

/**
 * {@link pinEligible} on a config file already written: rewrites it when a pin moved.
 *
 * @param path The `deno.json` / `deno.jsonc`.
 * @param dir The project directory.
 * @param opts Injected lookups, rule and clock.
 * @returns The outcome (its `text` is what the file now holds).
 */
export async function pinEligibleFile(
  path: string,
  dir: string,
  opts: EligibleOptions = {},
): Promise<EligibleOutcome> {
  const before = await Deno.readTextFile(path);
  const out = await pinEligible(before, dir, opts);
  if (out.ok && out.text !== before) await Deno.writeTextFile(path, out.text);
  return out;
}

/**
 * {@link pinEligible} over several configs written together (a monorepo's root, app and
 * packages): planned over their joined text, so every pin moves to the same version, and each
 * file rewritten when a pin in it moved.
 *
 * @param paths The `deno.json` files.
 * @param dir The project (workspace root) directory.
 * @param opts Injected lookups, rule and clock.
 * @returns The outcome over the joined text.
 */
export async function pinEligibleFiles(
  paths: readonly string[],
  dir: string,
  opts: EligibleOptions = {},
): Promise<EligibleOutcome> {
  const texts = await Promise.all(paths.map((p) => Deno.readTextFile(p)));
  const out = await pinEligible(texts.join("\n"), dir, opts);
  if (!out.ok || out.steps.length === 0) return out;
  for (const [i, path] of paths.entries()) {
    const next = applyUpgrade(texts[i], out.steps);
    if (next !== texts[i]) await Deno.writeTextFile(path, next);
  }
  return out;
}
