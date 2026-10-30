/**
 * `denext mobile add`'s npm pins under the project's minimum dependency age: every plugin is
 * pinned to one exact version (never a range a package manager could resolve to a release
 * published minutes ago), and before installing, each pinned version's npm publish time is
 * checked against the same rule `create`, `migrate` and `upgrade` apply ({@link readProjectRule}
 * in `dep-age.ts`). A version too new is refused, never installed; an unreachable registry keeps
 * the pins with a note.
 *
 * @module
 */

import { type DepAgeRule, heldUntil, type HeldVersion, holdHead, isExcluded } from "./dep-age.ts";

/** A plain version (`8.5.2`, `8.0.0-rc.1`): what an exact pin holds. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * A package's publish times, by version (npm's `time` map). Rejects when the registry cannot be
 * read.
 */
export type NpmPublishTimes = (name: string) => Promise<Readonly<Record<string, string>>>;

/** How long one registry lookup may take (the full packument, which carries `time`). */
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Publish times from the public npm registry (`time` of the full packument; the abbreviated one
 * has none).
 *
 * @param opts The fetch to use (tests) and the per-package timeout.
 */
export function npmRegistryPublishTimes(
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): NpmPublishTimes {
  const fetchFn = opts.fetch ?? fetch;
  return async (name) => {
    const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
    const res = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`the npm registry answered ${res.status} for ${name}`);
    }
    const doc = await res.json() as { time?: unknown };
    const time = doc.time;
    return time !== null && typeof time === "object" ? time as Record<string, string> : {};
  };
}

/** `name@version` split at the version's `@` (a scoped name keeps its own). */
export function splitSpec(spec: string): { name: string; version: string } {
  const at = spec.indexOf("@", 1);
  return at < 0
    ? { name: spec, version: "" }
    : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** What {@link checkPinAges} found. */
export interface PinAgeReport {
  /** Pinned versions the rule does not let in yet. */
  readonly held: readonly HeldVersion[];
  /** Packages whose publish time could not be read (the pins are kept). */
  readonly unknown: readonly string[];
}

/**
 * Check exact pins against the dependency-age rule.
 *
 * @param specs The pins (`name@version`), each an exact version.
 * @param lookup The publish times.
 * @param rule The project's rule.
 * @param now The clock.
 * @throws {Error} For a spec that is not an exact version.
 */
export async function checkPinAges(
  specs: readonly string[],
  lookup: NpmPublishTimes,
  rule: DepAgeRule,
  now: Date = new Date(),
): Promise<PinAgeReport> {
  const held: HeldVersion[] = [];
  const unknown: string[] = [];
  const pins = specs.map(splitSpec);
  const bad = pins.find((p) => !EXACT_VERSION.test(p.version));
  if (bad) throw new Error(`${bad.name}@${bad.version} is not pinned to an exact version`);
  if (rule.cutoff === null) return { held, unknown };
  await Promise.all(pins.map(async ({ name, version }) => {
    if (isExcluded(rule, name, "npm")) return;
    let publishedAt: string | undefined;
    try {
      publishedAt = (await lookup(name))[version];
    } catch {
      unknown.push(`${name}@${version}`);
      return;
    }
    if (publishedAt === undefined) return void unknown.push(`${name}@${version}`);
    const until = heldUntil(rule, name, publishedAt, now);
    if (until) held.push({ name, version, publishedAt, until });
  }));
  return { held, unknown: unknown.sort() };
}

/**
 * Refuse pins the rule holds, naming when each becomes eligible; else the notes to print for
 * pins whose age could not be checked.
 *
 * @param report From {@link checkPinAges}.
 * @param now The clock.
 * @throws {Error} When a pinned version is too new.
 */
export function assertPinsEligible(report: PinAgeReport, now: Date = new Date()): string[] {
  if (report.held.length > 0) {
    const lines = report.held.map((h) => holdHead(h, now));
    throw new Error(
      `${lines.join(" ")} \`denext mobile add\` installs only exact versions your ` +
        "dependency-age rule (deno.json minimumDependencyAge, .npmrc min-release-age, Deno's " +
        "default) lets in: run it again after that",
    );
  }
  return report.unknown.length === 0 ? [] : [
    `dependency age: the npm registry could not be read for ${report.unknown.join(", ")}, so ` +
    "their publish times are unknown; installed the exact pins as listed",
  ];
}
