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

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A failing critical check makes `doctor` exit non-zero. */
  readonly critical: boolean;
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
    const checks: Check[] = [];

    const major = denoMajor();
    checks.push({
      name: "Deno version",
      ok: major >= MIN_DENO_MAJOR,
      detail: major >= MIN_DENO_MAJOR
        ? Deno.version.deno
        : `${Deno.version.deno} (need ${MIN_DENO_MAJOR}.x)`,
      critical: true,
    });

    const paths = await resolveProject(dir);
    const isSpa = paths.config?.mode === "spa";
    let appOk = true;
    if (!isSpa) {
      try {
        appOk = (await Deno.stat(paths.appDir)).isDirectory;
      } catch {
        appOk = false;
      }
      checks.push({
        name: "app directory",
        ok: appOk,
        detail: appOk ? paths.appDir : `missing: ${paths.appDir}`,
        critical: true,
      });
    }
    checks.push({
      name: "config",
      ok: true,
      detail: paths.config ? paths.configPath : "none (using defaults)",
      critical: false,
    });

    // Route conformance — the old `probe`, run only when there's an app to probe.
    if (!isSpa && appOk) {
      try {
        const report = await probeApp(dir);
        const failed = report.routes.filter((r) => !r.ok).length;
        checks.push({
          name: "route conformance",
          ok: report.ok,
          detail: report.ok
            ? `${report.routes.length} route(s) OK`
            : `${failed}/${report.routes.length} route(s) failed`,
          critical: true,
        });
      } catch (err) {
        checks.push({
          name: "route conformance",
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          critical: true,
        });
      }
    }

    for (const c of checks) {
      console.log(`  ${c.ok ? "✔" : "✖"} ${c.name.padEnd(20)} ${c.detail}`);
    }
    const failedCritical = checks.some((c) => c.critical && !c.ok);
    console.log(failedCritical ? "\n  Problems found.\n" : "\n  All checks passed.\n");
    if (failedCritical) Deno.exit(1);
  },
};
