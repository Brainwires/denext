// `deno audit` over the repository's root `deno.lock` (the npm packages the workspace packages, the
// build tooling and the tests resolve) and every example's own `examples/<name>/deno.lock` (what
// users copy), failing on a high or critical advisory in any of them:
//
//   deno task audit:npm
//
// A fixed version still under Deno's minimum dependency age (deno.json / `.npmrc`; two days by
// default) cannot be locked yet. Such an advisory goes in security/npm-audit-allow.json with the
// package, the reason and an `until` date (the day the fixed version clears the hold, or a few
// days after); the entry stops applying after that date, so a hold never outlives the fix.
// `deno audit --ignore` takes CVE ids only, so the allowlist is applied here, by GHSA id.
// Moderate and low advisories are printed and pass.
//
// The allowlist applies to every audited lock. The examples' npm `package-lock.json` files (the
// Capacitor and React Native shells' own tooling) are not audited here: npm is not part of
// denext's toolchain; `npm audit` them by hand when one changes.
//
// The advisory database is queried fresh on every run, so a new advisory against an unchanged
// lockfile fails too. ci.yml's `cargo-audit` job runs this as well, and `deno task precheck` runs
// it when a deno.lock, a deno.json, an example's package.json or the allowlist changed.

import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** The allowlist, repository-relative. */
export const ALLOW_FILE = "security/npm-audit-allow.json";

/** The severities that fail the audit. */
export const FAILING: readonly string[] = ["high", "critical"];

/** One advisory as `deno audit` prints it. */
export interface Advisory {
  /** The advisory's title. */
  readonly title: string;
  /** `low`, `moderate`, `high` or `critical`. */
  readonly severity: string;
  /** The npm package. */
  readonly package: string;
  /** The vulnerable range. */
  readonly vulnerable: string;
  /** The GHSA id from the advisory's URL (empty when it has none). */
  readonly id: string;
}

/** One allowlisted advisory. */
export interface Allowed {
  /** The GHSA id. */
  readonly id: string;
  /** The npm package it is reported against. */
  readonly package: string;
  /** Why it is allowed (normally: the fixed version is under the dependency-age hold). */
  readonly reason: string;
  /** The last day (`YYYY-MM-DD`, UTC) the entry applies. */
  readonly until: string;
}

/** Whether `path` (repository-relative) is an input of the npm audit. */
export function isNpmAuditInput(path: string): boolean {
  return path === "deno.lock" || path === "deno.json" || path === ALLOW_FILE ||
    /^packages\/[^/]+\/deno\.json$/.test(path) ||
    /^examples\/[^/]+\/(deno\.lock|deno\.json|package\.json)$/.test(path);
}

/**
 * The lockfiles the audit covers, repository-relative: the root `deno.lock`, then each
 * `examples/<name>/deno.lock` in name order.
 *
 * @param root The repository root.
 */
export async function auditedLocks(root: string = ROOT): Promise<string[]> {
  const examples: string[] = [];
  for await (const e of Deno.readDir(join(root, "examples"))) {
    if (!e.isDirectory) continue;
    try {
      if ((await Deno.stat(join(root, "examples", e.name, "deno.lock"))).isFile) {
        examples.push(`examples/${e.name}/deno.lock`);
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return ["deno.lock", ...examples.sort()];
}

/**
 * Parse `deno audit`'s report (run with `NO_COLOR=1`).
 *
 * @param text Its stdout and stderr.
 * @returns The advisories, or `null` when the text is not a finished report (a registry error).
 */
export function parseAudit(text: string): Advisory[] | null {
  if (/No known vulnerabilities found/.test(text)) return [];
  if (!/Found \d+ vulnerabilit/.test(text)) return null;
  const advisories: Advisory[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const field = (name: string) =>
      new RegExp(`${name}:\\s*(.+)$`, "m").exec(block)?.[1].trim() ?? "";
    const severity = field("Severity");
    const pkg = field("Package");
    if (!severity || !pkg || /^\d+ low/.test(severity)) continue;
    const title = /^\W*(\S.*)$/m.exec(block.trim())?.[1].trim() ?? "";
    advisories.push({
      title,
      severity,
      package: pkg,
      vulnerable: field("Vulnerable"),
      id: /GHSA(?:-[0-9a-z]{4}){3}/i.exec(field("Info"))?.[0] ?? "",
    });
  }
  return advisories;
}

/**
 * Read and check the allowlist: each entry a GHSA id, a package, a reason and a `YYYY-MM-DD`
 * date.
 *
 * @param text The file's content.
 * @returns The entries.
 */
export function parseAllowlist(text: string): Allowed[] {
  const data = JSON.parse(text) as { allow?: unknown };
  if (!Array.isArray(data.allow)) throw new Error(`${ALLOW_FILE}: "allow" must be an array`);
  return data.allow.map((entry, i) => {
    const e = entry as Partial<Allowed>;
    const where = `${ALLOW_FILE}: allow[${i}]`;
    if (typeof e.id !== "string" || !/^GHSA(-[0-9a-z]{4}){3}$/.test(e.id)) {
      throw new Error(`${where}: "id" must be a GHSA id`);
    }
    if (typeof e.package !== "string" || !e.package) throw new Error(`${where}: no "package"`);
    if (typeof e.reason !== "string" || !e.reason.trim()) throw new Error(`${where}: no "reason"`);
    if (typeof e.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.until)) {
      throw new Error(`${where}: "until" must be a YYYY-MM-DD date`);
    }
    return { id: e.id, package: e.package, reason: e.reason, until: e.until };
  });
}

/** The verdict over one report. */
export interface Verdict {
  /** High or critical advisories no live allowlist entry covers. */
  readonly failing: Advisory[];
  /** Advisories an allowlist entry covers. */
  readonly allowed: Advisory[];
  /** Allowlist entries past their `until` date. */
  readonly expired: Allowed[];
}

/**
 * Apply the severity bar and the allowlist.
 *
 * @param advisories The parsed report.
 * @param allow The allowlist.
 * @param today The UTC date, `YYYY-MM-DD`.
 */
export function judge(advisories: Advisory[], allow: Allowed[], today: string): Verdict {
  const live = allow.filter((a) => a.until >= today);
  const covered = (a: Advisory) => live.some((l) => l.id === a.id && l.package === a.package);
  const serious = advisories.filter((a) => FAILING.includes(a.severity));
  return {
    failing: serious.filter((a) => !covered(a)),
    allowed: advisories.filter(covered),
    expired: allow.filter((a) => a.until < today),
  };
}

/**
 * Run `deno audit` on one lockfile, from its own directory (an example is its own project);
 * returns the combined output.
 *
 * @param root The repository root.
 * @param lock The lockfile, repository-relative.
 */
export async function runAudit(root: string = ROOT, lock = "deno.lock"): Promise<string> {
  const { stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["audit", "--lock", "deno.lock"],
    cwd: join(root, dirname(lock)),
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  return `${decode(stdout)}\n${decode(stderr)}`;
}

/** One lockfile's audit. */
export interface LockAudit {
  /** The lockfile, repository-relative. */
  readonly lock: string;
  /** `deno audit`'s output. */
  readonly text: string;
  /** The parsed advisories, or `null` when `deno audit` did not finish a report. */
  readonly advisories: Advisory[] | null;
}

/**
 * Audit several lockfiles, a few at a time, in order.
 *
 * @param locks The lockfiles, repository-relative.
 * @param run Runs `deno audit` on one of them (the repository-relative path).
 * @param concurrency How many run at once.
 */
export async function auditLocks(
  locks: readonly string[],
  run: (lock: string) => Promise<string> = (lock) => runAudit(ROOT, lock),
  concurrency = 4,
): Promise<LockAudit[]> {
  const out: LockAudit[] = new Array(locks.length);
  let next = 0;
  const worker = async () => {
    while (next < locks.length) {
      const i = next++;
      const text = await run(locks[i]);
      out[i] = { lock: locks[i], text, advisories: parseAudit(text) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, locks.length) }, worker));
  return out;
}

if (import.meta.main) {
  const audits = await auditLocks(await auditedLocks());
  const allow = parseAllowlist(await Deno.readTextFile(`${ROOT}${ALLOW_FILE}`));
  const today = new Date().toISOString().slice(0, 10);
  const failing: string[] = [];
  let unfinished = false;
  for (const { lock, text, advisories } of audits) {
    if (advisories === null) {
      console.error(`npm audit: ${lock}: \`deno audit\` did not finish a report:\n${text.trim()}`);
      unfinished = true;
      continue;
    }
    if (advisories.length === 0) {
      console.log(`npm audit: ${lock}: no known vulnerabilities`);
      continue;
    }
    console.log(`\nnpm audit: ${lock}\n${text.trim()}`);
    const verdict = judge(advisories, allow, today);
    for (const a of verdict.allowed) {
      console.log(`npm audit: ${lock}: allowed ${a.id} (${a.package})`);
    }
    for (const a of verdict.failing) {
      failing.push(`${a.id || a.title} (${a.package}, ${a.severity}, ${lock})`);
    }
  }
  for (const e of judge([], allow, today).expired) {
    console.log(`npm audit: ${ALLOW_FILE} entry ${e.id} (${e.package}) expired ${e.until}`);
  }
  if (unfinished) Deno.exit(2);
  if (failing.length) {
    console.error(
      `\nnpm audit: ${failing.join(", ")}. Update the package (or the direct dependency that ` +
        "brings it in) to a fixed version Deno's dependency-age hold allows, in that lockfile; " +
        "when the fix is still under the hold, " +
        `add an entry with the date it clears to ${ALLOW_FILE}.`,
    );
    Deno.exit(1);
  }
  console.log("\nnpm audit: ok");
}
