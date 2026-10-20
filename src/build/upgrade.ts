// `denext upgrade` — move a project's `denext` pin, the CLI tasks pinned to it and every
// first-party `@denext/*` package to versions that work together, in one edit of `deno.json`.
//
// The rules:
//
// - **Every pin moves together.** `jsr:@denext/denext@^3.2.0` appears in the import map AND in
//   each `deno task` that runs the CLI (`deno run -A jsr:@denext/denext@^3.2.0/cli dev .`); all
//   of them get the same version, with the operator each one already had (`^`, `~`, exact).
// - **Compatible or nothing.** A first-party package's version declares the denext range it was
//   built against (its own `@denext/denext` import: `src/plugin/catalog.json` → `denext` for the
//   version this denext ships with, the package's published `deno.json` for any other). The
//   newest denext is chosen for which EVERY pinned first-party package has a version whose range
//   admits it; a package is never moved backwards. `--to <version>` names the denext version
//   instead, and a package with no compatible version is then an error, not a silent skew.
//   `--to` an older denext than the pin is refused unless `--allow-downgrade` says so.
// - **The whole history is searched.** Candidates are scanned newest first until one fits, over
//   every published version (bounded by {@link MAX_LOOKUPS} registry reads per run), so an old
//   but compatible plugin release is found.
// - **A package that doesn't import denext keeps its major.** Nothing ties its version to
//   denext's, so it moves only within its own caret range (`^0.2.0` admits `0.2.x`) unless
//   `--allow-major` opts in.
// - **An unreachable registry is an error.** A version whose config JSR didn't serve is never
//   taken as "incompatible": the plan fails with the reason instead.
// - **Only versions Deno will resolve.** A version published more recently than the project's
//   minimum dependency age (`src/build/dep-age.ts`; two days by default) is never picked; the
//   plan names the newest one it skipped and when it becomes eligible.
// - **The edit is textual.** Only the version inside each matched specifier changes, so the
//   file keeps its comments, order and formatting (a `deno.jsonc` included).
//
// Versions come from JSR (`meta.json`, then `<version>/deno.json` per candidate) through the
// hardened client in `src/ui/jsr.ts`; tests inject the lookups.

import CATALOG from "../plugin/catalog.json" with { type: "json" };
import { fetchJsrConfig, fetchJsrVersions, type JsrRequestOptions } from "../ui/jsr.ts";
import { type DepAgeRule, heldUntil, type HeldVersion, holdHead, holdMessage } from "./dep-age.ts";

/**
 * A first-party package specifier with a version: `jsr:@denext/<name>@<op><version>`, or the
 * `jsr:/@denext/<name>@<op><version>/` form an import-map prefix entry uses.
 */
const PIN_RE = /jsr:(\/?)@denext\/([a-z0-9-]+)@([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
/**
 * How many package-config reads (one per candidate version) one plan may make before it gives
 * up. Each is a JSR request; ranges are memoized, so this bounds the whole search.
 */
const MAX_LOOKUPS = 200;

/** A registry read failed or the search ran out of budget: the plan fails with this reason. */
class LookupError extends Error {}

// ── semver (the subset JSR versions and denext ranges use) ───────────────────

interface SemVer {
  readonly nums: readonly [number, number, number];
  readonly pre: readonly string[];
}

/** Parse `major.minor.patch[-pre][+build]`, or `null`. */
function parseVersion(v: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Compare two prerelease identifiers: numeric ones numerically, and below any alphanumeric. */
function compareIdent(a: string, b: string): number {
  const [na, nb] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two prerelease identifier lists (an empty list — a release — sorts last). */
function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const diff = compareIdent(a[i], b[i]);
    if (diff !== 0) return diff;
  }
  return Math.sign(a.length - b.length);
}

/**
 * Order two versions by semver precedence.
 *
 * @param a A version.
 * @param b Another version.
 * @returns Negative when `a` is older, positive when newer, 0 when equal (or unparseable).
 */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  return comparePre(x.pre, y.pre);
}

/**
 * Whether `version` satisfies `range` — `^x.y.z`, `~x.y.z`, `x.y.z`, `>=x.y.z` or `*`, with
 * npm's prerelease rule (a prerelease only matches a range whose own version is a prerelease
 * of the same `major.minor.patch`).
 *
 * @param version The version.
 * @param range The range.
 * @returns `false` for anything unparseable.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const r = range.trim();
  if (!v) return false;
  if (r === "*" || r === "") return v.pre.length === 0;
  const m = /^(\^|~|>=|=)?\s*(.+)$/.exec(r)!;
  const base = parseVersion(m[2]);
  if (!base) return false;
  if (v.pre.length && (base.pre.length === 0 || v.nums.join() !== base.nums.join())) return false;
  if (compareVersions(version, m[2]) < 0) return false;
  const [M, mi] = base.nums;
  switch (m[1]) {
    case "^":
      if (M > 0) return v.nums[0] === M;
      return mi > 0 ? v.nums[0] === 0 && v.nums[1] === mi : v.nums.join() === base.nums.join();
    case "~":
      return v.nums[0] === M && v.nums[1] === mi;
    case ">=":
      return true;
    default:
      return compareVersions(version, m[2]) === 0;
  }
}

// ── the plan ─────────────────────────────────────────────────────────────────

/** One pinned first-party package, as found in the config. */
export interface UpgradePin {
  /** The JSR package (`@denext/openapi`). */
  readonly name: string;
  /** The newest version any of its pins names. */
  readonly version: string;
}

/** What `denext upgrade` does (or would do) to one package. */
export interface UpgradeStep {
  /** The JSR package. */
  readonly name: string;
  /** The pinned version. */
  readonly from: string;
  /** The version it moves to (equal to `from` when it stays). */
  readonly to: string;
}

/** The registry lookups the planner needs (injected in tests). */
export interface UpgradeLookups {
  /**
   * A package's published versions (with each one's publish time when known), or `null` when
   * they can't be read.
   */
  versions(name: string): Promise<
    {
      latest: string;
      versions: readonly string[];
      published?: Readonly<Record<string, string>>;
    } | null
  >;
  /**
   * The `@denext/denext` range one published version declares: the range, `null` when it does
   * not import denext (any denext will do), `undefined` when it can't be read.
   */
  denextRange(name: string, version: string): Promise<string | null | undefined>;
}

/** What {@link planUpgrade} may do beyond the default. */
export interface UpgradeOptions {
  /** The denext version to move to (default: the newest every pinned package supports). */
  readonly to?: string;
  /** Let `to` name an older denext than the current pin. */
  readonly allowDowngrade?: boolean;
  /** Let a package that doesn't import denext move past its own caret range. */
  readonly allowMajor?: boolean;
  /** The project's dependency-age rule: versions it holds are never picked (default: none). */
  readonly rule?: DepAgeRule;
  /** The clock (tests). */
  readonly now?: Date;
}

/** A newer version the dependency-age rule held back, and the version pinned instead. */
export interface HeldStep {
  /** The held version. */
  readonly held: HeldVersion;
  /** What was pinned instead. */
  readonly pinned: string;
}

/** The outcome of planning. */
export type UpgradePlan =
  | {
    readonly ok: true;
    readonly steps: readonly UpgradeStep[];
    readonly changed: boolean;
    /** Newer versions the dependency-age rule held back (absent when none). */
    readonly held?: readonly HeldStep[];
  }
  | { readonly ok: false; readonly reason: string };

/**
 * The first-party pins in a config file's text: each `@denext/*` package once, at the newest
 * version any of its specifiers names.
 *
 * @param text The `deno.json` / `deno.jsonc` text.
 * @returns The pins, denext first.
 */
export function findPins(text: string): UpgradePin[] {
  const newest = new Map<string, string>();
  for (const [, , pkg, , version] of text.matchAll(PIN_RE)) {
    const name = `@denext/${pkg}`;
    const seen = newest.get(name);
    if (!seen || compareVersions(version, seen) > 0) newest.set(name, version);
  }
  return [...newest].map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name === "@denext/denext" ? -1 : b.name === "@denext/denext" ? 1 : 0);
}

/** Newest first; prereleases only when `allowPre`; never older than `floor`. */
function candidates(versions: readonly string[], floor: string, allowPre: boolean): string[] {
  return versions
    .filter((v) => compareVersions(v, floor) >= 0 && (allowPre || !parseVersion(v)?.pre.length))
    .sort((a, b) => compareVersions(b, a));
}

/** The catalog's range for one exact version (`undefined` when the catalog doesn't know it). */
function catalogRange(name: string, version: string): string | null | undefined {
  const entry = (CATALOG.plugins as { name: string; version: string; denext?: string }[])
    .find((p) => p.name === name && p.version === version);
  return entry ? entry.denext ?? null : undefined;
}

/**
 * Memoize the lookups for one run (a version's range is asked for once per denext target), turn
 * an unreadable answer into a {@link LookupError}, and stop after {@link MAX_LOOKUPS} reads.
 */
function cached(lookups: UpgradeLookups, rule?: DepAgeRule, now: Date = new Date()) {
  const versions = new Map<string, ReturnType<UpgradeLookups["versions"]>>();
  const ranges = new Map<string, Promise<string | null>>();
  let reads = 0;
  const read = async (name: string, version: string): Promise<string | null> => {
    if (++reads > MAX_LOOKUPS) {
      throw new LookupError(
        `gave up after ${MAX_LOOKUPS} JSR lookups without a compatible set; name the denext ` +
          "version with --to",
      );
    }
    const range = await lookups.denextRange(name, version);
    if (range === undefined) {
      throw new LookupError(`couldn't reach JSR to read ${name}@${version}'s deno.json`);
    }
    return range;
  };
  const versionsOf = (name: string) => {
    if (!versions.has(name)) versions.set(name, lookups.versions(name));
    return versions.get(name)!;
  };
  return {
    now,
    cutoff: rule ? rule.cutoff : null,
    versions: versionsOf,
    /** Why `version` is held: the held version's facts, or `null` when Deno resolves it. */
    async held(name: string, version: string): Promise<HeldVersion | null> {
      if (!rule) return null;
      const publishedAt = (await versionsOf(name))?.published?.[version];
      const until = heldUntil(rule, name, publishedAt, now);
      return until && publishedAt ? { name, version, publishedAt, until } : null;
    },
    denextRange(name: string, version: string): Promise<string | null> {
      const key = `${name}@${version}`;
      if (!ranges.has(key)) {
        const known = catalogRange(name, version);
        ranges.set(key, known !== undefined ? Promise.resolve(known) : read(name, version));
      }
      return ranges.get(key)!;
    },
  };
}

type CachedLookups = ReturnType<typeof cached>;

/**
 * The newest version of `pin` (not older than it) whose denext range admits `target`. A version
 * that imports no denext fits any target, but stays within the pin's caret range unless
 * `allowMajor`.
 */
async function compatibleVersion(
  pin: UpgradePin,
  target: string,
  lookups: CachedLookups,
  allowMajor: boolean,
): Promise<string | null> {
  const published = await lookups.versions(pin.name);
  if (!published) throw new LookupError(`couldn't reach JSR to read ${pin.name}'s versions`);
  const pre = (parseVersion(pin.version)?.pre.length ?? 0) > 0;
  const list = await notHeld(candidates(published.versions, pin.version, pre), pin, lookups);
  for (const version of list) {
    const range = await lookups.denextRange(pin.name, version);
    if (range === null) {
      if (allowMajor || satisfies(version, `^${pin.version}`)) return version;
    } else if (satisfies(target, range)) return version;
  }
  return null;
}

/**
 * The newest version of `name` above `pinned` that the rule holds back (what a hold line
 * names), or `null`.
 */
async function newestHeld(
  name: string,
  pinned: string,
  look: CachedLookups,
): Promise<HeldVersion | null> {
  const published = await look.versions(name);
  if (!published) return null;
  const pre = (parseVersion(pinned)?.pre.length ?? 0) > 0;
  for (const version of candidates(published.versions, pinned, pre)) {
    if (version === pinned) break;
    const held = await look.held(name, version);
    if (held) return held;
  }
  return null;
}

/** The hold lines for a finished plan: per package, the newest version it could not take. */
async function heldSteps(steps: readonly UpgradeStep[], look: CachedLookups): Promise<HeldStep[]> {
  const out: HeldStep[] = [];
  for (const step of steps) {
    const held = await newestHeld(step.name, step.to, look);
    if (held) out.push({ held, pinned: step.to });
  }
  return out;
}

/** Resolve every non-denext pin against one denext version; `null` names the first misfit. */
async function resolveAll(
  pins: readonly UpgradePin[],
  target: string,
  lookups: CachedLookups,
  allowMajor: boolean,
): Promise<{ steps: UpgradeStep[] } | { misfit: string }> {
  const steps: UpgradeStep[] = [];
  for (const pin of pins) {
    const to = await compatibleVersion(pin, target, lookups, allowMajor);
    if (to === null) return { misfit: pin.name };
    steps.push({ name: pin.name, from: pin.version, to });
  }
  return { steps };
}

/**
 * Plan an upgrade of the pins in `text`.
 *
 * @param text The config text (a workspace's configs joined: every pin in them moves together).
 * @param options `to`: the denext version to move to (default: the newest that every pinned
 *   first-party package supports, never older than the current pin); `allowDowngrade`,
 *   `allowMajor`: see {@link UpgradeOptions}.
 * @param lookups The registry lookups.
 * @returns The steps (denext first), or why no consistent set exists — including a JSR read
 *   that failed, which is never taken for an incompatible version.
 */
export async function planUpgrade(
  text: string,
  options: UpgradeOptions,
  lookups: UpgradeLookups,
): Promise<UpgradePlan> {
  const memo = memoized(lookups);
  const down = options.rule && options.to === undefined
    ? await planEligiblePins(text, memo, options.rule, options.now)
    : null;
  if (down && !down.ok && !down.offline) return { ok: false, reason: down.reason };
  if (down?.ok && down.changed) return await planFromEligible(text, down, options, memo);
  try {
    return await planWith(text, options, cached(memo, options.rule, options.now));
  } catch (err) {
    if (err instanceof LookupError) return { ok: false, reason: err.message };
    throw err;
  }
}

/**
 * A pin the rule still holds (an app made before denext stopped exempting itself) first moves
 * down to the newest version it lets in, so the app resolves today; then the usual plan runs
 * from there, and its steps are reported from the pins as they were.
 */
async function planFromEligible(
  text: string,
  down: EligiblePlan & { ok: true },
  options: UpgradeOptions,
  memo: UpgradeLookups,
): Promise<UpgradePlan> {
  const plan = await planUpgrade(applyUpgrade(text, down.steps), options, memo);
  if (!plan.ok) return plan;
  const from = new Map(findPins(text).map((p) => [p.name, p.version]));
  const steps = plan.steps.map((s) => ({ ...s, from: from.get(s.name) ?? s.from }));
  const later = plan.held ?? [];
  const names = new Set(later.map((h) => h.held.name));
  const held = [...down.held.filter((h) => !names.has(h.held.name)), ...later];
  return { ok: true, steps, changed: steps.some((s) => s.from !== s.to), held };
}

/** The lookups with every answer kept for the run (two plans share one set of requests). */
function memoized(lookups: UpgradeLookups): UpgradeLookups {
  const versions = new Map<string, ReturnType<UpgradeLookups["versions"]>>();
  const ranges = new Map<string, ReturnType<UpgradeLookups["denextRange"]>>();
  return {
    versions(name) {
      if (!versions.has(name)) versions.set(name, lookups.versions(name));
      return versions.get(name)!;
    },
    denextRange(name, version) {
      const key = `${name}@${version}`;
      if (!ranges.has(key)) ranges.set(key, lookups.denextRange(name, version));
      return ranges.get(key)!;
    },
  };
}

/** Why `options.to` can't be planned (unpublished, or older than the pin without opt-in). */
function refuseTarget(
  options: UpgradeOptions,
  pinned: string,
  published: readonly string[],
): string | null {
  const to = options.to;
  if (to === undefined) return null;
  if (!published.includes(to)) return `@denext/denext ${to} is not a published version`;
  if (!options.allowDowngrade && compareVersions(to, pinned) < 0) {
    return `--to ${to} is older than the pinned @denext/denext ${pinned}; pass ` +
      "--allow-downgrade to move it back";
  }
  return null;
}

/** {@link planUpgrade} over memoized lookups; a failed read throws a {@link LookupError}. */
async function planWith(
  text: string,
  options: UpgradeOptions,
  look: CachedLookups,
): Promise<UpgradePlan> {
  const pins = findPins(text);
  const denext = pins.find((p) => p.name === "@denext/denext");
  if (!denext) {
    return { ok: false, reason: "no versioned jsr:@denext/denext pin in this config" };
  }
  const others = pins.filter((p) => p !== denext);
  const published = await look.versions(denext.name);
  if (!published) {
    return { ok: false, reason: "couldn't reach JSR to read @denext/denext's versions" };
  }
  const refused = refuseTarget(options, denext.version, published.versions) ??
    await refuseHeldTarget(options.to, denext, look);
  if (refused) return { ok: false, reason: refused };
  const pre = (parseVersion(denext.version)?.pre.length ?? 0) > 0;
  const targets = options.to !== undefined
    ? [options.to]
    : await notHeld(candidates(published.versions, denext.version, pre), denext, look);
  const fit = await firstFit(others, targets, look, options.allowMajor === true);
  if ("misfit" in fit) {
    return { ok: false, reason: misfitReason(fit.misfit, targets, options, denext) };
  }
  return await finishedPlan(
    [{ name: denext.name, from: denext.version, to: fit.target }, ...fit.steps],
    look,
  );
}

/** Why no consistent set exists: the package with no version for the denext targets tried. */
function misfitReason(
  misfit: string,
  targets: readonly string[],
  options: UpgradeOptions,
  denext: UpgradePin,
): string {
  const range = options.to === undefined ? ` (or any older denext down to ${denext.version})` : "";
  return `no published version of ${misfit} supports @denext/denext ${targets[0] ?? "?"}${range}`;
}

/** The plan for `steps`, with the hold lines for newer versions it could not take. */
async function finishedPlan(steps: UpgradeStep[], look: CachedLookups): Promise<UpgradePlan> {
  const held = await heldSteps(steps, look);
  return {
    ok: true,
    steps,
    changed: steps.some((s) => s.from !== s.to),
    ...(held.length ? { held } : {}),
  };
}

/**
 * The versions the rule lets in, in order. The pin itself always stays: an upgrade never moves a
 * pin backwards.
 */
async function notHeld(
  versions: readonly string[],
  pin: UpgradePin,
  look: CachedLookups,
): Promise<string[]> {
  const out: string[] = [];
  for (const v of versions) {
    if (v === pin.version || !(await look.held(pin.name, v))) out.push(v);
  }
  return out;
}

/** Why `--to` can't be pinned yet (the rule holds it), or `null`. */
async function refuseHeldTarget(
  to: string | undefined,
  denext: UpgradePin,
  look: CachedLookups,
): Promise<string | null> {
  if (to === undefined || to === denext.version) return null;
  const held = await look.held(denext.name, to);
  return held ? `${holdHead(held, look.now)} --to ${to} can't be pinned until then.` : null;
}

/** The first denext target (in order) every other pin has a version for, or the last misfit. */
async function firstFit(
  others: readonly UpgradePin[],
  targets: readonly string[],
  look: CachedLookups,
  allowMajor: boolean,
): Promise<{ target: string; steps: UpgradeStep[] } | { misfit: string }> {
  let misfit = "";
  for (const target of targets) {
    const resolved = await resolveAll(others, target, look, allowMajor);
    if (!("misfit" in resolved)) return { target, steps: resolved.steps };
    misfit = resolved.misfit;
  }
  return { misfit };
}

// ── pinning what the dependency-age rule lets in (`create` / `migrate`) ─────

/** The outcome of {@link planEligiblePins}. */
export type EligiblePlan =
  | {
    readonly ok: true;
    readonly steps: readonly UpgradeStep[];
    readonly changed: boolean;
    readonly held: readonly HeldStep[];
  }
  | {
    readonly ok: false;
    /** JSR could not be read: nothing is known about the hold. */
    readonly offline: boolean;
    readonly reason: string;
  };

/** Whether a version is a prerelease. */
function isPre(version: string): boolean {
  return (parseVersion(version)?.pre.length ?? 0) > 0;
}

/**
 * The newest version of `pin` at or below it that the rule lets in and, given a denext
 * `target`, whose denext range admits it; with the first held version met on the way down.
 */
async function eligibleAtOrBelow(
  pin: UpgradePin,
  look: CachedLookups,
  target: string | null,
): Promise<{ version: string | null; held: HeldVersion | null }> {
  const published = await look.versions(pin.name);
  if (!published) throw new LookupError(`couldn't reach JSR to read ${pin.name}'s versions`);
  // Not published (a development build of the CLI): there is nothing to hold, nor to pick.
  if (!published.versions.includes(pin.version)) return { version: pin.version, held: null };
  const pre = isPre(pin.version);
  const list = published.versions
    .filter((v) => compareVersions(v, pin.version) <= 0 && (pre || !isPre(v)))
    .sort((a, b) => compareVersions(b, a));
  let firstHeld: HeldVersion | null = null;
  for (const version of list) {
    const held = await look.held(pin.name, version);
    if (held) {
      firstHeld ??= held;
      continue;
    }
    if (target !== null) {
      const range = await look.denextRange(pin.name, version);
      if (range !== null && !satisfies(target, range)) continue;
    }
    return { version, held: firstHeld };
  }
  return { version: null, held: firstHeld };
}

/**
 * Plan the pins a freshly generated config (`denext create` / `migrate`) should carry so Deno
 * resolves them under the project's dependency-age rule: each `@denext/*` pin stays when the
 * rule already lets it in; otherwise it moves DOWN to the newest version that is old enough —
 * for a first-party package, one whose denext range admits the denext chosen. Never upward:
 * that is `denext upgrade`'s job.
 *
 * @param text The generated config text.
 * @param lookups The registry lookups.
 * @param rule The project's dependency-age rule.
 * @param now The clock.
 * @returns The steps and the hold lines, or why nothing eligible exists (`offline` when JSR
 *   could not be read, so nothing is known).
 */
export async function planEligiblePins(
  text: string,
  lookups: UpgradeLookups,
  rule: DepAgeRule,
  now: Date = new Date(),
): Promise<EligiblePlan> {
  const look = cached(lookups, rule, now);
  try {
    return await eligibleWith(findPins(text), look);
  } catch (err) {
    if (err instanceof LookupError) return { ok: false, offline: true, reason: err.message };
    throw err;
  }
}

/** Why no version of `pin` can be pinned: the hold on it, or no old-enough one fitting `target`. */
function nothingEligible(
  pin: UpgradePin,
  held: HeldVersion | null,
  target: string,
  look: CachedLookups,
): string {
  return held
    ? holdMessage(held, null, look.now)
    : `no version of ${pin.name} old enough for your dependency-age rule supports denext ${target}`;
}

/** {@link planEligiblePins} over memoized lookups. */
async function eligibleWith(
  pins: readonly UpgradePin[],
  look: CachedLookups,
): Promise<EligiblePlan> {
  const denext = pins.find((p) => p.name === "@denext/denext");
  if (!denext || look.cutoff === null) return { ok: true, steps: [], changed: false, held: [] };
  const steps: UpgradeStep[] = [];
  const held: HeldStep[] = [];
  let target = denext.version;
  for (const pin of [denext, ...pins.filter((p) => p !== denext)]) {
    const fit = await eligibleAtOrBelow(pin, look, pin === denext ? null : target);
    if (fit.version === null) {
      return { ok: false, offline: false, reason: nothingEligible(pin, fit.held, target, look) };
    }
    if (pin === denext) target = fit.version;
    steps.push({ name: pin.name, from: pin.version, to: fit.version });
    if (fit.held && fit.version !== pin.version) held.push({ held: fit.held, pinned: fit.version });
  }
  return { ok: true, steps, changed: steps.some((s) => s.from !== s.to), held };
}

/**
 * Rewrite every pinned specifier in `text` to its step's `to` version, keeping each one's
 * operator and everything around it.
 *
 * @param text The config text.
 * @param steps The plan's steps.
 * @returns The new text.
 */
export function applyUpgrade(text: string, steps: readonly UpgradeStep[]): string {
  const to = new Map(steps.map((s) => [s.name, s.to]));
  return text.replace(PIN_RE, (whole, slash: string, pkg: string, op: string) => {
    const version = to.get(`@denext/${pkg}`);
    return version === undefined ? whole : `jsr:${slash}@denext/${pkg}@${op}${version}`;
  });
}

/**
 * The registry lookups over JSR.
 *
 * @param opts Request options for every JSR call (a signal, an injected fetch).
 * @returns Lookups for {@link planUpgrade}.
 */
export function jsrLookups(opts: JsrRequestOptions = {}): UpgradeLookups {
  const split = (name: string) => name.slice(1).split("/") as [string, string];
  return {
    async versions(name) {
      const res = await fetchJsrVersions(...split(name), opts);
      return res.ok
        ? { latest: res.latest, versions: res.versions, published: res.published }
        : null;
    },
    async denextRange(name, version) {
      const res = await fetchJsrConfig(...split(name), version, opts);
      if (!res.ok) return undefined;
      const imports = (res.value as { imports?: Record<string, unknown> })?.imports;
      const spec = imports?.["@denext/denext"];
      if (typeof spec !== "string") return null;
      const m = /^jsr:@denext\/denext@([^/]+)$/.exec(spec);
      return m ? m[1] : null;
    },
  };
}
