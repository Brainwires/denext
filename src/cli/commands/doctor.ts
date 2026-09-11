// `info` (environment + project facts) and `doctor` (actionable diagnostics that
// supersede the old `probe` verb). `doctor` runs a series of checks — Deno version,
// app dir, config load, and in-process route conformance — printing a pass/fail
// line each and exiting non-zero when a critical check fails (the CI gate `probe`
// used to be, now with environment context around it). `doctor --report` folds the
// same data — plus every route's conformance result and the last build's client
// chunks — into one markdown (or, with `--json`, structured) health report.

import { join } from "@std/path";
import { denoVersionOk, MIN_DENO_VERSION } from "../../build/deno-version.ts";
import { VERSION } from "../../../mod.ts";
import type { CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { resolveProject } from "../../build/paths.ts";
import { type ConformanceReport, probeApp } from "../../testing/conformance.ts";
import {
  type BundleChunk,
  bundleReportMarkdown,
  readClientChunks,
} from "../../build/bundle-report.ts";

export const infoCommand: CommandSpec = {
  name: "info",
  summary: "Print environment + project facts",
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const paths = await resolveProject(dir);
    const facts = {
      denext: VERSION,
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      platform: `${Deno.build.os}/${Deno.build.arch}`,
      projectDir: dir,
      config: paths.config ? paths.configPath : null,
      mode: paths.config?.mode ?? "app-router",
      appDir: paths.appDir,
    };
    if (ctx.global.json) {
      console.log(JSON.stringify(facts, null, 2));
      return;
    }
    console.log(`\n  denext     ${facts.denext}`);
    console.log(`  deno       ${facts.deno} (v8 ${facts.v8})`);
    console.log(`  platform   ${facts.platform}`);
    console.log(`  project    ${facts.projectDir}`);
    console.log(`  config     ${facts.config ?? "— (using defaults)"}`);
    console.log(`  mode       ${facts.mode}`);
    console.log(`  app dir    ${facts.appDir}\n`);
  },
};

/** One diagnostic line of a {@link DoctorReport}. */
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A failing critical check makes `doctor` exit non-zero. */
  readonly critical: boolean;
}

/**
 * The structured health report behind `denext doctor --report` (and the `denext_doctor`
 * MCP tool's `report` mode): the pass/fail checks plus the two data sets they summarize.
 */
export interface DoctorReport {
  /** The project directory diagnosed. */
  readonly dir: string;
  /** The checks `denext doctor` prints, in report order. */
  readonly checks: Check[];
  /**
   * Every route's conformance result (the data the `route conformance` check collapses
   * to one line), or `null` when routes weren't probed — SPA mode, a missing app
   * directory, or a config failure.
   */
  readonly routes: ConformanceReport | null;
  /**
   * The client chunks of the last `denext build` (read from `.denext/client`, no build
   * is run), or `null` when the project has no build output yet.
   */
  readonly bundle: BundleChunk[] | null;
}

/** The Deno-version check. */
function denoVersionCheck(): Check {
  const ok = denoVersionOk(Deno.version.deno);
  return {
    name: "Deno version",
    ok,
    detail: ok ? Deno.version.deno : `${Deno.version.deno} (need ≥ ${MIN_DENO_VERSION})`,
    critical: true,
  };
}

/** The app-directory-exists check. */
async function appDirCheck(appDir: string): Promise<Check> {
  let ok = false;
  try {
    ok = (await Deno.stat(appDir)).isDirectory;
  } catch {
    ok = false;
  }
  return {
    name: "app directory",
    ok,
    detail: ok ? appDir : `missing: ${appDir}`,
    critical: true,
  };
}

/** The route-conformance check (the old `probe`), plus the full report it summarizes. */
async function routeConformance(
  dir: string,
): Promise<{ check: Check; report: ConformanceReport | null }> {
  try {
    const report = await probeApp(dir);
    const failed = report.routes.filter((r) => !r.ok).length;
    const check: Check = {
      name: "route conformance",
      ok: report.ok,
      detail: report.ok
        ? `${report.routes.length} route(s) OK`
        : `${failed}/${report.routes.length} route(s) failed`,
      critical: true,
    };
    return { check, report };
  } catch (err) {
    const check: Check = {
      name: "route conformance",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      critical: true,
    };
    return { check, report: null };
  }
}

/**
 * The last build's client chunks, or `null` when `outDir` holds no client build output.
 * Reads what `denext build` emitted; never builds.
 */
async function builtClientChunks(outDir: string): Promise<BundleChunk[] | null> {
  const clientDir = join(outDir, "client");
  try {
    if (!(await Deno.stat(clientDir)).isDirectory) return null;
  } catch {
    return null;
  }
  return await readClientChunks(clientDir);
}

/**
 * Gather the full denext project-health report for a directory: the checks
 * (Deno version, config correctness, app directory, route conformance), every
 * route's conformance result, and the last build's client chunks. Pure data: no
 * printing, no exit, no build.
 *
 * @param dir The project directory to diagnose.
 * @returns The report; see {@link DoctorReport} for when a section is `null`.
 */
export async function collectDoctorReport(dir: string): Promise<DoctorReport> {
  const checks: Check[] = [denoVersionCheck()];

  // resolveProject loads + validates denext.config and throws on a malformed one; catch it
  // so `doctor` reports config *correctness* as a failed check, not a crash before any print.
  let paths;
  try {
    paths = await resolveProject(dir);
  } catch (err) {
    checks.push({
      name: "config",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      critical: true,
    });
    return { dir, checks, routes: null, bundle: null };
  }

  const isSpa = paths.config?.mode === "spa";
  let appOk = true;
  if (!isSpa) {
    const appCheck = await appDirCheck(paths.appDir);
    appOk = appCheck.ok;
    checks.push(appCheck);
  }
  // Reaching here means the config loaded and passed validation → report correctness.
  checks.push({
    name: "config",
    ok: true,
    detail: paths.config ? `loaded & validated: ${paths.configPath}` : "none (using defaults)",
    critical: false,
  });
  let routes: ConformanceReport | null = null;
  if (!isSpa && appOk) {
    const r = await routeConformance(dir);
    checks.push(r.check);
    routes = r.report;
  }

  return { dir, checks, routes, bundle: await builtClientChunks(paths.outDir) };
}

/** The checks alone (the plain `denext doctor` listing); see {@link collectDoctorReport}. */
async function collectDoctorChecks(dir: string): Promise<Check[]> {
  return (await collectDoctorReport(dir)).checks;
}

/** Whether a failing critical check is present (the non-zero-exit condition). */
function hasCriticalFailure(checks: Check[]): boolean {
  return checks.some((c) => c.critical && !c.ok);
}

/** Escape a value for a markdown table cell. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** The `## Routes` section body: a per-route table, or why routes weren't probed. */
function routesSection(rep: ConformanceReport | null): string[] {
  if (!rep) {
    return ["_Not probed — SPA mode, a missing app directory, or a config failure above._"];
  }
  if (rep.routes.length === 0) return ["_No routes found._"];
  const lines = [
    `${rep.passed} rendered · ${rep.skipped} skipped · ${rep.failed} failed · ` +
    `${rep.static}/${rep.total} static (0 KB JS)`,
    "",
    "| Route | Path | Status | Kind | Result |",
    "| --- | --- | --: | --- | --- |",
  ];
  for (const p of rep.routes) {
    const kind = p.rendered ? (p.interactive ? "interactive" : "static") : (p.note ?? "—");
    const failures = p.checks.filter((c) => !c.pass).map((c) =>
      c.detail ? `${c.name}: ${c.detail}` : c.name
    );
    const result = p.ok ? "✔" : `✖ ${failures.join("; ")}`;
    lines.push(
      `| \`${cell(p.routePath)}\` | \`${cell(p.path)}\` | ${p.status || "—"} | ${cell(kind)} | ${
        cell(result)
      } |`,
    );
  }
  return lines;
}

/** The `## Client bundle` section body: the chunk/role tables, or how to get them. */
function bundleSection(chunks: BundleChunk[] | null): string[] {
  if (chunks === null) {
    return [
      "_Not built — run `denext build`, then re-run `denext doctor --report` for chunk " +
      "sizes by role (`denext analyze` builds and reports in one step)._",
    ];
  }
  // bundleReportMarkdown is a standalone document (an H1 + H2s); drop its title and nest
  // its headings one level under this section.
  return bundleReportMarkdown(chunks).slice(2).map((l) => l.startsWith("#") ? `#${l}` : l);
}

/**
 * Render a {@link DoctorReport} as markdown — the `denext doctor --report` output a
 * human or CI can act on: a verdict, the checklist, every route's conformance, and the
 * client bundle by chunk and role.
 *
 * @param report The report from {@link collectDoctorReport}.
 * @returns Markdown lines.
 */
export function doctorReportMarkdown(report: DoctorReport): string[] {
  const failed = hasCriticalFailure(report.checks);
  return [
    `# denext doctor — ${report.dir}`,
    "",
    `**Verdict:** ${failed ? "problems found" : "all checks passed"} · ` +
    `denext ${VERSION} · Deno ${Deno.version.deno}`,
    "",
    "## Checks",
    "",
    ...report.checks.map((c) =>
      `- ${c.ok ? "✔" : "✖"} **${c.name}** — ${c.detail}${c.critical ? "" : " _(advisory)_"}`
    ),
    "",
    "## Routes",
    "",
    ...routesSection(report.routes),
    "",
    "## Client bundle",
    "",
    ...bundleSection(report.bundle),
    "",
    "_Profile a route's CPU and heap with `denext profile <path>` (headless Chromium; " +
    "not part of this report)._",
  ];
}

/** Print each check line, then a summary; exit non-zero if a critical check failed. */
function reportChecks(checks: Check[]): void {
  for (const c of checks) {
    console.log(`  ${c.ok ? "✔" : "✖"} ${c.name.padEnd(20)} ${c.detail}`);
  }
  const failedCritical = hasCriticalFailure(checks);
  console.log(
    failedCritical ? "\n  Problems found.\n" : "\n  All checks passed.\n",
  );
  if (failedCritical) Deno.exit(1);
}

/**
 * Collect the report with stdout kept clean for `> report.md` / `| jq`: any progress
 * logging during collection is routed to stderr (the `analyze --md` convention).
 */
async function collectQuietly(dir: string): Promise<DoctorReport> {
  const origLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await collectDoctorReport(dir);
  } finally {
    console.log = origLog;
  }
}

export const doctorCommand: CommandSpec = {
  name: "doctor",
  summary: "Diagnose the project (supersedes probe)",
  aliases: ["probe"],
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [{
    name: "report",
    type: "boolean",
    help: "Print a markdown health report (checks, every route's conformance, the last " +
      "build's client bundle by chunk); with --json, the same data as JSON",
  }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const report = ctx.flags.report === true;
    if (report || ctx.global.json) {
      const r = await collectQuietly(dir);
      if (ctx.global.json) console.log(JSON.stringify(report ? r : r.checks, null, 2));
      else console.log(doctorReportMarkdown(r).join("\n"));
      if (hasCriticalFailure(r.checks)) Deno.exit(1);
      return;
    }
    console.log(`\n  denext doctor  ▸  ${dir}\n`);
    reportChecks(await collectDoctorChecks(dir));
  },
};
