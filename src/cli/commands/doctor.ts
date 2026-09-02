// `info` (environment + project facts) and `doctor` (actionable diagnostics that
// supersede the old `probe` verb). `doctor` runs a series of checks — Deno version,
// app dir, config load, and in-process route conformance — printing a pass/fail
// line each and exiting non-zero when a critical check fails (the CI gate `probe`
// used to be, now with environment context around it).

import { VERSION } from "../../../mod.ts";
import type { CommandSpec } from "../command.ts";
import { projectDir } from "../shared.ts";
import { resolveProject } from "../../build/paths.ts";
import { probeApp } from "../../testing/conformance.ts";

/** Minimum Deno major denext supports (the `deno bundle` subcommand). */
const MIN_DENO_MAJOR = 2;

/** The Deno major version, or 0 if unparseable. */
function denoMajor(): number {
  const m = /^(\d+)\./.exec(Deno.version.deno);
  return m ? Number(m[1]) : 0;
}

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

/** One diagnostic line produced by {@link collectDoctorChecks}. */
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A failing critical check makes `doctor` exit non-zero. */
  readonly critical: boolean;
}

/** The Deno-version check. */
function denoVersionCheck(): Check {
  const major = denoMajor();
  const ok = major >= MIN_DENO_MAJOR;
  return {
    name: "Deno version",
    ok,
    detail: ok ? Deno.version.deno : `${Deno.version.deno} (need ${MIN_DENO_MAJOR}.x)`,
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
  return { name: "app directory", ok, detail: ok ? appDir : `missing: ${appDir}`, critical: true };
}

/** The route-conformance check (the old `probe`). */
async function routeConformanceCheck(dir: string): Promise<Check> {
  try {
    const report = await probeApp(dir);
    const failed = report.routes.filter((r) => !r.ok).length;
    return {
      name: "route conformance",
      ok: report.ok,
      detail: report.ok
        ? `${report.routes.length} route(s) OK`
        : `${failed}/${report.routes.length} route(s) failed`,
      critical: true,
    };
  } catch (err) {
    return {
      name: "route conformance",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      critical: true,
    };
  }
}

/**
 * Gather the denext project-health checks for a directory (Deno version, config
 * correctness, app directory, route conformance) — the reusable core behind the
 * `doctor` command and the `denext_doctor` MCP tool. Pure data: no printing, no exit.
 *
 * @param dir The project directory to diagnose.
 * @returns The checks in report order.
 */
export async function collectDoctorChecks(dir: string): Promise<Check[]> {
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
    return checks;
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
  if (!isSpa && appOk) checks.push(await routeConformanceCheck(dir));

  return checks;
}

/** Print each check line, then a summary; exit non-zero if a critical check failed. */
function reportChecks(checks: Check[]): void {
  for (const c of checks) {
    console.log(`  ${c.ok ? "✔" : "✖"} ${c.name.padEnd(20)} ${c.detail}`);
  }
  const failedCritical = checks.some((c) => c.critical && !c.ok);
  console.log(failedCritical ? "\n  Problems found.\n" : "\n  All checks passed.\n");
  if (failedCritical) Deno.exit(1);
}

export const doctorCommand: CommandSpec = {
  name: "doctor",
  summary: "Diagnose the project (supersedes probe)",
  aliases: ["probe"],
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    console.log(`\n  denext doctor  ▸  ${dir}\n`);
    reportChecks(await collectDoctorChecks(dir));
  },
};
