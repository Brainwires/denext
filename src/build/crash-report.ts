// Opt-in crash reports from denext's Deno (runtime 3.0.0-denext.5, Brainwires/deno DENEXT.md item
// 180): the CLI and `denort` (a `deno compile` / `denext build --compile` program) send one JSON
// report when they panic, to `DENEXT_CRASH_REPORT_URL` (an `https:` endpoint, or a local `file:`
// path that gets one line appended). The runtime reads the variable at start-up from the
// environment only; nothing here bakes it into a build, an image or a manifest, because such a URL
// often carries an ingest token.
//
// denext's side: the variable's checks (`denext doctor`), the application name its CLI hops hand
// down (`DENEXT_CRASH_REPORT_APP=denext@<version>`) and `denext crash-report test`, which panics a
// toolchain `deno --version` on purpose (`DENEXT_CRASH_REPORT_SELFTEST=1`) to check the pipeline.
// No message here ever prints the URL's value: it may hold a token.

import { fromFileUrl } from "@std/path";
import { supportsCrashReports } from "./deno-version.ts";

/** Turns crash reports on: `https://…` or `file:///abs/path.jsonl`. */
export const CRASH_REPORT_URL_ENV = "DENEXT_CRASH_REPORT_URL";
/** The application name a report carries (`denext@4.10.4`). */
export const CRASH_REPORT_APP_ENV = "DENEXT_CRASH_REPORT_APP";
/** `1` (with a valid URL): the runtime panics on purpose just after start-up. */
export const CRASH_REPORT_SELFTEST_ENV = "DENEXT_CRASH_REPORT_SELFTEST";

/** The application names the runtime accepts (others are sent as `null`). */
const APP_NAME = /^[A-Za-z0-9@._+/-]{1,64}$/;

/**
 * What is wrong with a `DENEXT_CRASH_REPORT_URL` value, by the runtime's own rules: an `https:`
 * URL, or a `file:` URL without a host (a host would be a network share). The answer never
 * repeats the value.
 *
 * @param value The variable's value.
 * @returns Why the runtime would ignore it, or `null` when it is accepted.
 */
export function crashReportUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") return "is http://, which is refused (use https://)";
  if (url.protocol === "file:") {
    return url.hostname === "" ? null : "is a file:// URL with a host, which is refused";
  }
  return `has the scheme ${url.protocol} (only https: and file: are accepted)`;
}

/**
 * Whether a CLI child on `runtime` reads the crash-report variables: denext's Deno from
 * 3.0.0-denext.5, or a `DENEXT_DENO=<path>` build (`"path"`), whose version is unknown (the
 * variables are harmless where they are not read).
 *
 * @param runtime The child's toolchain marker (a version or `"path"`), `undefined` for stock Deno.
 * @returns Whether to hand it the application name.
 */
function readsCrashReportEnv(runtime: string | undefined): boolean {
  return runtime === "path" || (runtime !== undefined && supportsCrashReports(runtime));
}

/** What decides the application name a CLI hop gets. */
export interface CrashReportAppInputs {
  /** The child's runtime: a toolchain marker (a version or `"path"`), `undefined` for stock Deno. */
  readonly runtime: string | undefined;
  /** Reads this process's environment. */
  readonly env: (name: string) => string | undefined;
  /** This denext's version. */
  readonly version: string;
}

/**
 * The environment a denext CLI hop (the toolchain, pinned-denext, CSS / module-config and limits
 * re-runs) adds so a crash report names denext: `DENEXT_CRASH_REPORT_APP=denext@<version>`, for a
 * runtime that reads it, unless the variable is already set (the operator's own name stands).
 *
 * @param inputs The child's runtime, the environment and denext's version.
 * @returns The variables to add (none, or the one).
 */
export function crashReportAppEnv(inputs: CrashReportAppInputs): Record<string, string> {
  if (inputs.env(CRASH_REPORT_APP_ENV) !== undefined) return {};
  if (!readsCrashReportEnv(inputs.runtime)) return {};
  const app = `denext@${inputs.version}`;
  return APP_NAME.test(app) ? { [CRASH_REPORT_APP_ENV]: app } : {};
}

/** One `denext doctor` line (the shape of `Check` in src/cli/commands/doctor.ts). */
export interface CrashReportCheck {
  /** `crash reports`. */
  readonly name: string;
  /** Whether reports will be sent as configured. */
  readonly ok: boolean;
  /** What is set and what happens. */
  readonly detail: string;
  /** Always `false`: crash reports are optional. */
  readonly critical: boolean;
}

/** Where a valid URL sends reports, without its value (an `https:` URL may carry a token). */
function destination(value: string): string {
  const url = new URL(value);
  return url.protocol === "https:" ? `an https endpoint (${url.host})` : `the file ${url.pathname}`;
}

/**
 * The `denext doctor` check of `DENEXT_CRASH_REPORT_URL`: `null` while it is unset; a warning
 * when the runtime would ignore it (`http:`, a `file://` host, not a URL) or when the running
 * Deno sends no reports (stock Deno, or denext's before 3.0.0-denext.5).
 *
 * @param env Reads the environment.
 * @param runtime The running Deno's denext version (`Deno.build.denext`), `undefined` for stock.
 * @returns The check, or `null`.
 */
export function crashReportCheck(
  env: (name: string) => string | undefined,
  runtime: string | undefined,
): CrashReportCheck | null {
  const value = env(CRASH_REPORT_URL_ENV);
  if (value === undefined || value === "") return null;
  const name = "crash reports";
  const problem = crashReportUrlProblem(value);
  if (problem) {
    return {
      name,
      ok: false,
      detail: `${CRASH_REPORT_URL_ENV} ${problem}: the runtime ignores it and sends no reports`,
      critical: false,
    };
  }
  if (runtime === undefined || !supportsCrashReports(runtime)) {
    const on = runtime === undefined
      ? "stock Deno sends no crash reports"
      : `denext's Deno ${runtime} sends none`;
    return {
      name,
      ok: false,
      detail: `${CRASH_REPORT_URL_ENV} is set but unsupported: ${on} (they need denext's Deno ` +
        "toolchain 3.0.0-denext.5 or later)",
      critical: false,
    };
  }
  return {
    name,
    ok: true,
    detail: `on: a panic is reported to ${destination(value)}; check it with ` +
      "`denext crash-report test`",
    critical: false,
  };
}

/** What `denext crash-report test` runs and reads. */
export interface CrashReportTestOptions {
  /** Reads the environment (`DENEXT_CRASH_REPORT_URL`, `DENEXT_CRASH_REPORT_APP`). */
  readonly env: (name: string) => string | undefined;
  /** The toolchain's `deno`. */
  readonly deno: string;
  /** Its marker: a version, `"path"` (a `DENEXT_DENO=<path>` build) or `undefined` (stock). */
  readonly runtime: string | undefined;
  /** denext's version (the application name). */
  readonly version: string;
  /** Run `deno --version` with `env` added; resolves its exit code and standard error. */
  readonly run?: (
    deno: string,
    env: Record<string, string>,
  ) => Promise<{ code: number; stderr: string }>;
}

/** The outcome of `denext crash-report test`. */
export interface CrashReportTestResult {
  /** Whether the self-test panicked and (for a file) wrote a report. */
  readonly ok: boolean;
  /** What to print, one line each. */
  readonly lines: string[];
}

/** Run `deno --version` with `env` added, its output captured. */
async function runSelftest(
  deno: string,
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const out = await new Deno.Command(deno, {
    args: ["--version"],
    env,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
}

/** A file's bytes, or none when it does not exist yet. */
async function readBytes(path: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return new Uint8Array();
    throw err;
  }
}

/** The report lines a file gained past `from` bytes. */
function newLines(bytes: Uint8Array, from: number): string[] {
  return new TextDecoder().decode(bytes.subarray(from)).split("\n").filter((l) => l.trim() !== "");
}

/** Whether `line` is a self-test report (JSON with `kind: "selftest"`). */
function isSelftestReport(line: string): boolean {
  try {
    const report = JSON.parse(line) as { kind?: unknown };
    return report.kind === "selftest";
  } catch {
    return false;
  }
}

/** Why the configured URL or runtime can't run the self-test, or `null`. */
function selftestRefusal(value: string | undefined, runtime: string | undefined): string | null {
  if (value === undefined || value === "") {
    return `${CRASH_REPORT_URL_ENV} is not set: set it to an https:// endpoint or a ` +
      "file:///absolute/path.jsonl, then run this again";
  }
  const problem = crashReportUrlProblem(value);
  if (problem) return `${CRASH_REPORT_URL_ENV} ${problem}`;
  if (!readsCrashReportEnv(runtime)) {
    return runtime === undefined
      ? "stock Deno sends no crash reports: run this on denext's Deno toolchain " +
        "(unset DENEXT_DENO=stock)"
      : `denext's Deno ${runtime} sends no crash reports (they arrived in 3.0.0-denext.5): ` +
        "upgrade denext";
  }
  return null;
}

/**
 * `denext crash-report test`: run the toolchain's `deno --version` with
 * `DENEXT_CRASH_REPORT_SELFTEST=1`, which panics on purpose and sends one `kind: "selftest"`
 * report to the configured URL. Passes when the process panicked and, for a `file:` URL, the
 * report line was appended (it is shown); an `https:` endpoint's answer is not read by the
 * runtime, so look for the report there.
 *
 * @param options The environment, the toolchain and the seams.
 * @returns Whether it passed, and what to print.
 */
export async function crashReportTest(
  options: CrashReportTestOptions,
): Promise<CrashReportTestResult> {
  const value = options.env(CRASH_REPORT_URL_ENV);
  const refusal = selftestRefusal(value, options.runtime);
  if (refusal !== null || value === undefined) {
    return { ok: false, lines: [`denext crash-report test: ${refusal}`] };
  }
  const file = new URL(value).protocol === "file:" ? fromFileUrl(value) : null;
  const before = file ? (await readBytes(file)).length : 0;
  const env: Record<string, string> = {
    [CRASH_REPORT_URL_ENV]: value,
    [CRASH_REPORT_SELFTEST_ENV]: "1",
    ...crashReportAppEnv({ ...options, runtime: "path" }),
  };
  const { code, stderr } = await (options.run ?? runSelftest)(options.deno, env);
  if (code === 0) {
    const warning = stderr.split("\n").find((l) => l.includes(CRASH_REPORT_URL_ENV));
    return {
      ok: false,
      lines: [
        "denext crash-report test: the self-test did not panic, so no report was sent" +
        (warning ? ` (${warning.trim()})` : ""),
      ],
    };
  }
  const lines = [`self-test panicked as intended (exit ${code})`];
  if (!file) {
    lines.push(
      `one report (kind "selftest") was posted to ${destination(value)}; the runtime does not ` +
        "read the answer, so check that it arrived there",
    );
    return { ok: true, lines };
  }
  const report = newLines(await readBytes(file), before).find(isSelftestReport);
  if (!report) {
    lines.push(`denext crash-report test: no self-test report was appended to ${file}`);
    return { ok: false, lines };
  }
  lines.push(`report appended to ${file}:`, report);
  return { ok: true, lines };
}
