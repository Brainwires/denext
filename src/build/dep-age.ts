// Deno's minimum dependency age, as denext reads it to pick versions Deno will resolve.
//
// Deno (2.9+) holds a version published less than `minimumDependencyAge` ago out of resolution
// (two days by default on Deno 2.9.7): a compromised release is refused while it is fresh. denext never
// weakens that hold on the user's behalf. Instead `create`, `migrate` and `upgrade` pin the
// newest `@denext/*` version that is ALREADY old enough under the project's effective rule, and
// say when a newer one becomes eligible.
//
// The rule, in Deno's order: `--min-dep-age` (denext forwards the operator's
// `DENEXT_MIN_DEP_AGE` as that flag, which also drops the config's `exclude`) → the root
// `deno.json`'s `minimumDependencyAge` (minutes, an ISO-8601 duration, an RFC 3339 date, `0` /
// `false` to disable, or `{ age, exclude }`) → `.npmrc`'s `min-release-age` (days) → Deno's default.
// An `exclude` entry (`jsr:@scope/name`, or a `jsr:@scope/*` prefix) lifts the hold for a package.

import { parse as parseJsonc } from "@std/jsonc";
import { join } from "@std/path";

/**
 * Deno's default hold, in minutes, as Deno 2.9.7 enforces it: its source names 1440 and its
 * error hint says "24 hours", but with no rule configured it reports (and applies) a cutoff two
 * days back — measured against JSR on both the stock 2.9.7 and denext's toolchain. Pinning by
 * the longer window never picks a version Deno then refuses.
 */
const DEFAULT_MIN_DEP_AGE_MINUTES = 2880;

/** The exclude entry `denext create` / `migrate` wrote before 4.5.2. */
export const DENEXT_EXCLUDE = "jsr:@denext/*";

/** A project's effective dependency-age rule. */
export interface DepAgeRule {
  /** The newest publish time Deno resolves; `null` when the hold is off. */
  readonly cutoff: Date | null;
  /** `minimumDependencyAge.exclude` (empty under a `--min-dep-age` override). */
  readonly exclude: readonly string[];
  /** Where the age came from. */
  readonly source: "env" | "config" | "npmrc" | "default";
  /** The age is a fixed cutoff date (a version after it never becomes eligible). */
  readonly absolute?: boolean;
}

/** Where to read the rule from (all optional; tests inject them). */
export interface DepAgeInputs {
  /** The root config's `minimumDependencyAge` value. */
  readonly config?: unknown;
  /** `DENEXT_MIN_DEP_AGE` (forwarded by denext as `--min-dep-age`). */
  readonly env?: string;
  /** `.npmrc`'s `min-release-age`, in days. */
  readonly npmrcDays?: number;
  /** The clock. */
  readonly now?: Date;
}

const MINUTE = 60_000;
/** The largest Date: "never" for a version past a fixed cutoff date. */
const NEVER = 8.64e15;

/** An ISO-8601 duration as Deno reads it (`PnW` alone, or `PnDTnHnMnS`), in ms; `null` if not. */
function parseDuration(s: string): number | null {
  const week = /^P(\d+)W$/i.exec(s);
  if (week) return Number(week[1]) * 7 * 1440 * MINUTE;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
  if (!m || s.length <= 1 || /T$/i.test(s) || m.slice(1).every((v) => v === undefined)) return null;
  const [d, h, min, sec] = m.slice(1).map((v) => Number(v ?? 0));
  return ((d * 24 + h) * 60 + min) * MINUTE + sec * 1000;
}

/**
 * One age value as Deno reads it: the cutoff date, `null` when it disables the hold, or
 * `undefined` when it is absent or unreadable (the next source applies).
 *
 * @param value A `minimumDependencyAge` / `age` / `--min-dep-age` value.
 * @param now The clock.
 * @returns The cutoff, `null`, or `undefined`.
 */
export function parseAge(value: unknown, now: Date): Date | null | undefined {
  if (value === false || value === 0 || value === "0") return null;
  if (typeof value === "number" && Number.isInteger(value)) {
    return new Date(now.getTime() - value * MINUTE);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const s = value.trim();
  if (/^\d+$/.test(s)) return new Date(now.getTime() - Number(s) * MINUTE);
  if (/^P/i.test(s)) {
    const ms = parseDuration(s);
    return ms === null ? undefined : new Date(now.getTime() - ms);
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Whether an age value is a fixed date rather than a duration. */
function isAbsolute(value: unknown): boolean {
  return typeof value === "string" && !/^\s*(\d+|P.*)\s*$/i.test(value);
}

/**
 * The effective rule from its sources, in Deno's precedence order.
 *
 * @param inputs The config value, the env override, `.npmrc`'s days, the clock.
 * @returns The rule.
 */
export function effectiveRule(inputs: DepAgeInputs): DepAgeRule {
  const now = inputs.now ?? new Date();
  if (inputs.env !== undefined && inputs.env !== "") {
    const cutoff = parseAge(inputs.env, now);
    if (cutoff !== undefined) {
      return { cutoff, exclude: [], source: "env", absolute: isAbsolute(inputs.env) };
    }
  }
  const cfg = inputs.config;
  const obj = cfg !== null && typeof cfg === "object" && !Array.isArray(cfg)
    ? cfg as { age?: unknown; exclude?: unknown }
    : null;
  const exclude = Array.isArray(obj?.exclude)
    ? obj.exclude.filter((e): e is string => typeof e === "string")
    : [];
  const value = obj ? obj.age : cfg;
  const age = parseAge(value, now);
  if (age !== undefined) {
    return { cutoff: age, exclude, source: "config", absolute: isAbsolute(value) };
  }
  if (inputs.npmrcDays !== undefined) {
    const cutoff = inputs.npmrcDays === 0
      ? null
      : new Date(now.getTime() - inputs.npmrcDays * 1440 * MINUTE);
    return { cutoff, exclude, source: "npmrc" };
  }
  return {
    cutoff: new Date(now.getTime() - DEFAULT_MIN_DEP_AGE_MINUTES * MINUTE),
    exclude,
    source: "default",
  };
}

/**
 * Whether the rule lifts the hold for a JSR package (an exact or `*`-prefix `exclude` entry).
 *
 * @param rule The rule.
 * @param name The package (`@denext/denext`).
 * @returns `true` when Deno would not hold it.
 */
export function isExcluded(rule: DepAgeRule, name: string): boolean {
  return rule.exclude.some((entry) => {
    if (!entry.startsWith("jsr:")) return false;
    const pattern = entry.slice(4);
    if (!pattern.endsWith("*")) return pattern === name;
    const prefix = pattern.slice(0, -1);
    return prefix !== "" && name.startsWith(prefix);
  });
}

/**
 * When a version becomes eligible: `null` when it already is (or nothing holds it).
 *
 * @param rule The rule.
 * @param name The package.
 * @param publishedAt The version's JSR `createdAt` (absent: Deno has nothing to hold it by).
 * @param now The clock.
 * @returns The moment the hold on it ends, or `null`.
 */
export function heldUntil(
  rule: DepAgeRule,
  name: string,
  publishedAt: string | undefined,
  now: Date = new Date(),
): Date | null {
  if (rule.cutoff === null || publishedAt === undefined || isExcluded(rule, name)) return null;
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime()) || published <= rule.cutoff) return null;
  // A relative rule ends `age` after publishing; a fixed cutoff date never lets it in.
  if (rule.absolute) return new Date(NEVER);
  return new Date(published.getTime() + (now.getTime() - rule.cutoff.getTime()));
}

/** `.npmrc`'s `min-release-age` (days) from the project's file, else the user's. */
async function npmrcDays(dir: string): Promise<number | undefined> {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  for (const path of [join(dir, ".npmrc"), ...(home ? [join(home, ".npmrc")] : [])]) {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    const m = /^\s*min-release-age\s*=\s*(\d+)\s*$/m.exec(text);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** `DENEXT_MIN_DEP_AGE`, or `undefined` without env access. */
function envOverride(): string | undefined {
  try {
    return Deno.env.get("DENEXT_MIN_DEP_AGE");
  } catch {
    return undefined;
  }
}

/**
 * The effective rule for the project in `dir` (its `deno.json` / `deno.jsonc`, `.npmrc`, and
 * `DENEXT_MIN_DEP_AGE`).
 *
 * @param dir The project directory.
 * @param now The clock.
 * @param configText The root config's text, when the caller has it (e.g. about to be rewritten).
 * @returns The rule.
 */
export async function readProjectRule(
  dir: string,
  now: Date = new Date(),
  configText?: string,
): Promise<DepAgeRule> {
  let config: unknown;
  const texts = configText !== undefined ? [configText] : await configTexts(dir);
  for (const text of texts) {
    try {
      config = (parseJsonc(text) as Record<string, unknown> | null)?.minimumDependencyAge;
      break;
    } catch { /* unreadable: try the next */ }
  }
  return effectiveRule({ config, env: envOverride(), npmrcDays: await npmrcDays(dir), now });
}

/** The project's `deno.json`, then `deno.jsonc`, texts (those that exist). */
async function configTexts(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      out.push(await Deno.readTextFile(join(dir, name)));
    } catch { /* absent */ }
  }
  return out;
}

/** "3 h ago", "40 min ago", "2 days ago". */
function ago(publishedAt: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(publishedAt)) / MINUTE));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** A moment in the user's local time, e.g. "Oct 21, 3:12 PM CDT". */
function localTime(date: Date): string {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** One held version, for {@link holdMessage}. */
export interface HeldVersion {
  /** The package (`@denext/denext`). */
  readonly name: string;
  /** The version that is too new. */
  readonly version: string;
  /** Its JSR `createdAt`. */
  readonly publishedAt: string;
  /** When the rule lets it in. */
  readonly until: Date;
}

/** How a package is named in messages: `denext` for the framework, the JSR name otherwise. */
function display(name: string): string {
  return name === "@denext/denext" ? "denext" : name;
}

/**
 * The first sentence of a hold line: when the version was published and when the rule lets it
 * in.
 *
 * @param held The held version.
 * @param now The clock.
 * @param format The local-time formatter (injected by tests).
 * @returns The sentence.
 */
export function holdHead(
  held: HeldVersion,
  now: Date = new Date(),
  format: (d: Date) => string = localTime,
): string {
  const when = held.until.getTime() >= NEVER
    ? "your dependency-age rule (a fixed cutoff date) does not allow it"
    : `your dependency-age rule allows it from ${format(held.until)}`;
  return `${display(held.name)} ${held.version} was published ${
    ago(held.publishedAt, now)
  }; ${when}.`;
}

/**
 * The one line that says a version is held and what was pinned instead (or, with `pinned`
 * `null`, that nothing old enough exists).
 *
 * @param held The held version.
 * @param pinned The version pinned instead, or `null`.
 * @param now The clock.
 * @param format The local-time formatter (injected by tests).
 * @returns The message.
 */
export function holdMessage(
  held: HeldVersion,
  pinned: string | null,
  now: Date = new Date(),
  format: (d: Date) => string = localTime,
): string {
  const head = holdHead(held, now, format);
  return pinned === null
    ? `${head} No older ${display(held.name)} version is old enough to pin instead — ` +
      `run this again after that.`
    : `${head} Pinned ${pinned} for now — run "denext upgrade" after that.`;
}

/**
 * Remove the `"jsr:@denext/*"` entry from a config's `minimumDependencyAge.exclude`, leaving
 * every other entry (and the rest of the file's text) as it was. An `exclude` left empty is
 * removed, and a `minimumDependencyAge` object left empty with it.
 *
 * @param text The `deno.json` / `deno.jsonc` text.
 * @returns The new text and whether the entry was there.
 */
export function stripDenextExclude(text: string): { text: string; removed: boolean } {
  let parsed: { minimumDependencyAge?: { exclude?: unknown } } | undefined;
  try {
    parsed = parseJsonc(text) as typeof parsed;
  } catch {
    return { text, removed: false };
  }
  const age = parsed?.minimumDependencyAge;
  const exclude = age && typeof age === "object" && Array.isArray(age.exclude) ? age.exclude : [];
  if (!exclude.includes(DENEXT_EXCLUDE)) return { text, removed: false };
  const keyAt = text.search(/"minimumDependencyAge"\s*:/);
  if (keyAt < 0) return { text, removed: false };
  const open = text.indexOf("{", keyAt);
  const close = matchingBrace(text, open);
  if (open < 0 || close < 0) return { text, removed: false };
  const rest = Object.keys(age as object).filter((k) => k !== "exclude");
  const kept = exclude.filter((e) => e !== DENEXT_EXCLUDE);
  const body = text.slice(open, close + 1);
  let next: string;
  if (kept.length) {
    next = body.replace(
      /("exclude"\s*:\s*)\[[^\]]*\]/,
      (_m, key: string) => `${key}[${kept.map((e) => JSON.stringify(e)).join(", ")}]`,
    );
  } else if (rest.length) {
    next = body.replace(
      /,?\s*"exclude"\s*:\s*\[[^\]]*\]\s*,?/,
      (m) => m.trimStart().startsWith(",") && m.trimEnd().endsWith(",") ? "," : "",
    );
  } else {
    return { text: removeMember(text, keyAt, close), removed: true };
  }
  return { text: text.slice(0, open) + next + text.slice(close + 1), removed: true };
}

/** The index of the `}` closing the `{` at `open` (strings respected), or -1. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Remove the object member spanning `[keyAt, end]` with its separating comma and line. */
function removeMember(text: string, keyAt: number, end: number): string {
  const after = /^\s*,/.exec(text.slice(end + 1));
  if (after) {
    const lineStart = text.lastIndexOf("\n", keyAt - 1) + 1;
    const start = /^\s*$/.test(text.slice(lineStart, keyAt)) ? lineStart : keyAt;
    let stop = end + 1 + after[0].length;
    const nl = /^[ \t]*\r?\n/.exec(text.slice(stop));
    if (nl && start === lineStart) stop += nl[0].length;
    return text.slice(0, start) + text.slice(stop);
  }
  const before = /,\s*$/.exec(text.slice(0, keyAt));
  const start = before ? keyAt - before[0].length : keyAt;
  return text.slice(0, start) + text.slice(end + 1);
}
