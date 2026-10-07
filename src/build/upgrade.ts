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
// - **The edit is textual.** Only the version inside each matched specifier changes, so the
//   file keeps its comments, order and formatting (a `deno.jsonc` included).
//
// Versions come from JSR (`meta.json`, then `<version>/deno.json` per candidate) through the
// hardened client in `src/ui/jsr.ts`; tests inject the lookups.

import CATALOG from "../plugin/catalog.json" with { type: "json" };
import { fetchJsrConfig, fetchJsrVersions, type JsrRequestOptions } from "../ui/jsr.ts";

/** A first-party package specifier with a version: `jsr:@denext/<name>@<op><version>`. */
const PIN_RE = /jsr:@denext\/([a-z0-9-]+)@([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
/** How many candidate versions of one package are inspected (newest first). */
const MAX_CANDIDATES = 8;
/** How many denext versions are tried, newest first, before giving up on a common set. */
const MAX_TARGETS = 6;

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
  /** A package's published versions, or `null` when they can't be read. */
  versions(name: string): Promise<{ latest: string; versions: readonly string[] } | null>;
  /**
   * The `@denext/denext` range one published version declares: the range, `null` when it does
   * not import denext (any denext will do), `undefined` when it can't be read.
   */
  denextRange(name: string, version: string): Promise<string | null | undefined>;
}

/** The outcome of planning. */
export type UpgradePlan =
  | { readonly ok: true; readonly steps: readonly UpgradeStep[]; readonly changed: boolean }
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
  for (const [, pkg, , version] of text.matchAll(PIN_RE)) {
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

/** Memoize the lookups for one run (a version's range is asked for once per denext target). */
function cached(lookups: UpgradeLookups): UpgradeLookups {
  const versions = new Map<string, ReturnType<UpgradeLookups["versions"]>>();
  const ranges = new Map<string, ReturnType<UpgradeLookups["denextRange"]>>();
  return {
    versions(name) {
      if (!versions.has(name)) versions.set(name, lookups.versions(name));
      return versions.get(name)!;
    },
    denextRange(name, version) {
      const key = `${name}@${version}`;
      if (!ranges.has(key)) {
        const known = catalogRange(name, version);
        ranges.set(
          key,
          known !== undefined ? Promise.resolve(known) : lookups.denextRange(name, version),
        );
      }
      return ranges.get(key)!;
    },
  };
}

/** The newest version of `pin` (not older than it) whose denext range admits `target`. */
async function compatibleVersion(
  pin: UpgradePin,
  target: string,
  lookups: UpgradeLookups,
): Promise<string | null> {
  const published = await lookups.versions(pin.name);
  const pre = (parseVersion(pin.version)?.pre.length ?? 0) > 0;
  const list = published ? candidates(published.versions, pin.version, pre) : [pin.version];
  for (const version of list.slice(0, MAX_CANDIDATES)) {
    const range = await lookups.denextRange(pin.name, version);
    if (range === null || (range !== undefined && satisfies(target, range))) return version;
  }
  return null;
}

/** Resolve every non-denext pin against one denext version; `null` names the first misfit. */
async function resolveAll(
  pins: readonly UpgradePin[],
  target: string,
  lookups: UpgradeLookups,
): Promise<{ steps: UpgradeStep[] } | { misfit: string }> {
  const steps: UpgradeStep[] = [];
  for (const pin of pins) {
    const to = await compatibleVersion(pin, target, lookups);
    if (to === null) return { misfit: pin.name };
    steps.push({ name: pin.name, from: pin.version, to });
  }
  return { steps };
}

/**
 * Plan an upgrade of the pins in `text`.
 *
 * @param text The config text.
 * @param options `to`: the denext version to move to (default: the newest that every pinned
 *   first-party package supports, never older than the current pin).
 * @param lookups The registry lookups.
 * @returns The steps (denext first), or why no consistent set exists.
 */
export async function planUpgrade(
  text: string,
  options: { to?: string },
  lookups: UpgradeLookups,
): Promise<UpgradePlan> {
  const pins = findPins(text);
  const denext = pins.find((p) => p.name === "@denext/denext");
  if (!denext) {
    return { ok: false, reason: "no versioned jsr:@denext/denext pin in this config" };
  }
  const look = cached(lookups);
  const others = pins.filter((p) => p !== denext);
  const published = await look.versions(denext.name);
  if (!published) return { ok: false, reason: "could not read @denext/denext's versions from JSR" };
  if (options.to !== undefined && !published.versions.includes(options.to)) {
    return { ok: false, reason: `@denext/denext ${options.to} is not a published version` };
  }
  const pre = (parseVersion(denext.version)?.pre.length ?? 0) > 0;
  const targets = options.to !== undefined
    ? [options.to]
    : candidates(published.versions, denext.version, pre).slice(0, MAX_TARGETS);
  let misfit = "";
  for (const target of targets) {
    const resolved = await resolveAll(others, target, look);
    if ("misfit" in resolved) {
      misfit = resolved.misfit;
      continue;
    }
    const steps = [{ name: denext.name, from: denext.version, to: target }, ...resolved.steps];
    return { ok: true, steps, changed: steps.some((s) => s.from !== s.to) };
  }
  return {
    ok: false,
    reason: `no published version of ${misfit} supports @denext/denext ${targets[0] ?? "?"}` +
      (options.to === undefined ? " (or any newer denext that was tried)" : ""),
  };
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
  return text.replace(PIN_RE, (whole, pkg: string, op: string) => {
    const version = to.get(`@denext/${pkg}`);
    return version === undefined ? whole : `jsr:@denext/${pkg}@${op}${version}`;
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
      return res.ok ? { latest: res.latest, versions: res.versions } : null;
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
