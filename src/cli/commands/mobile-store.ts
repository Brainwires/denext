// The store / compliance / debugging actions of `denext mobile`:
//
//   denext mobile privacy [--check] [--write]   print and validate ios/App/App/PrivacyInfo.xcprivacy
//                                               (--write merges every installed capability's
//                                               required-reason entries; --check exits 1 on errors)
//   denext mobile doctor --store | --release    App Review readiness / release security checks
//   denext mobile inspect [--platform ios|android] [--dry-run]
//                                               attach Safari Web Inspector / chrome://inspect
//
// None of them loads the project's modules: they read configs and native files as data.

import { resolve } from "@std/path";
import type { CommandContext } from "../command.ts";
import { MOBILE_CAPABILITIES } from "../../build/mobile-capabilities.ts";
import {
  checkPrivacyManifest,
  detectInstalledCapabilities,
  type PrivacyCheck,
  type PrivacyFinding,
  requiredPrivacyEntries,
  writePrivacyManifests,
} from "../../build/mobile-privacy.ts";
import {
  formatMobileDoctor,
  type MobileDoctorProfile,
  type MobileDoctorReport,
  runMobileDoctor,
} from "../../build/mobile-doctor.ts";
import {
  type InspectPlatform,
  type InspectRunner,
  inspectSteps,
  openInspector,
} from "../../build/mobile-inspect.ts";
import { capacitorConfigFile, readCapacitorConfig } from "../../build/capacitor-config.ts";

/** Print `message` to stderr and exit 1. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

/** The Capacitor project: `--dir`, else the positional, else `.`. */
function projectRoot(ctx: CommandContext): string {
  const dir = typeof ctx.flags.dir === "string" ? ctx.flags.dir : ctx.positionals[1] ?? ".";
  return resolve(ctx.global.cwd ?? ".", dir);
}

/** A finding as two lines. */
function findingLines(f: PrivacyFinding): string[] {
  return [
    `  ${f.level === "error" ? "ERROR  " : "WARNING"} ${f.file}: ${f.message}`,
    `          fix: ${f.fix}`,
  ];
}

/** `--write`: merge every installed capability's entries, and say what changed. */
async function writePrivacy(ctx: CommandContext, root: string): Promise<void> {
  const installed = await detectInstalledCapabilities(root, MOBILE_CAPABILITIES);
  const report = await writePrivacyManifests(root, requiredPrivacyEntries(installed), {
    ensureApp: true,
    dryRun: ctx.flags["dry-run"] === true,
  });
  if (ctx.global.json) return;
  for (const path of report.written) {
    const added = report.added[path];
    console.log(`  wrote      ${path}${added ? ` (+ ${added.join("; ")})` : ""}`);
  }
  for (const path of report.unchanged) console.log(`  unchanged  ${path}`);
  for (const note of [...report.skipped, ...report.manual]) console.log(`  note       ${note}`);
}

/** Print the manifest and its findings. */
function printPrivacy(check: PrivacyCheck, errors: number): void {
  const installed = check.installed.join(", ") || "none detected";
  console.log(`\n  ${check.file} (capabilities: ${installed})\n`);
  console.log(check.text === undefined ? "  (no manifest)" : check.text.trimEnd());
  console.log("");
  for (const f of check.findings) console.log(findingLines(f).join("\n"));
  const warnings = check.findings.length - errors;
  console.log(
    check.findings.length === 0
      ? "  The privacy manifest is valid."
      : `\n  ${errors} error(s), ${warnings} warning(s).`,
  );
}

/** `denext mobile privacy [--write] [--check]`. */
export async function mobilePrivacy(ctx: CommandContext): Promise<void> {
  const root = projectRoot(ctx);
  let check: PrivacyCheck;
  try {
    if (ctx.flags.write === true) await writePrivacy(ctx, root);
    check = await checkPrivacyManifest(root, MOBILE_CAPABILITIES);
  } catch (err) {
    fail(`denext mobile privacy: ${err instanceof Error ? err.message : String(err)}`);
  }
  const errors = check.findings.filter((f) => f.level === "error").length;
  if (ctx.global.json) console.log(JSON.stringify(check));
  else printPrivacy(check, errors);
  if (ctx.flags.check === true && errors > 0) Deno.exit(1);
}

/** The profiles `--store` / `--release` ask for. */
function doctorProfiles(ctx: CommandContext): MobileDoctorProfile[] {
  const profiles: MobileDoctorProfile[] = [];
  if (ctx.flags.store === true) profiles.push("store");
  if (ctx.flags.release === true) profiles.push("release");
  if (profiles.length === 0) {
    fail(
      "denext mobile doctor: pass --store (App Review readiness) and/or --release (release " +
        "security checks).",
    );
  }
  return profiles;
}

/** `denext mobile doctor --store | --release [--app <dir>]`. */
export async function mobileDoctor(ctx: CommandContext): Promise<void> {
  const root = projectRoot(ctx);
  const appDir = typeof ctx.flags.app === "string"
    ? resolve(ctx.global.cwd ?? ".", ctx.flags.app)
    : root;
  const reports: MobileDoctorReport[] = [];
  try {
    for (const profile of doctorProfiles(ctx)) {
      reports.push(await runMobileDoctor({ root, profile, appDir }));
    }
  } catch (err) {
    fail(`denext mobile doctor: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ctx.global.json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports));
  else {
    for (const report of reports) {
      console.log(`\n  denext mobile doctor --${report.profile}  ▸  ${root}\n`);
      console.log(formatMobileDoctor(report));
    }
  }
  if (reports.some((r) => r.findings.some((f) => f.level === "error"))) Deno.exit(1);
}

/** Runs a command with its stdout captured. */
const captureRun: InspectRunner = async (cmd, args) => {
  const out = await new Deno.Command(cmd, { args: [...args], stdout: "piped", stderr: "null" })
    .output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
};

/** The `--platform` value. */
function inspectPlatform(ctx: CommandContext): InspectPlatform {
  const value = ctx.flags.platform;
  if (value === undefined) return "all";
  if (value === "ios" || value === "android") return value;
  fail(`denext mobile inspect: --platform takes ios or android (got ${JSON.stringify(value)}).`);
}

/** The Capacitor `appName`, for the steps. */
async function appName(root: string): Promise<string | undefined> {
  const file = await capacitorConfigFile(root);
  if (!file) return undefined;
  const config = await readCapacitorConfig(file, await Deno.readTextFile(file)).catch(() => null);
  return typeof config?.appName === "string" ? config.appName : undefined;
}

/**
 * `denext mobile inspect [--platform ios|android] [--dry-run]`.
 *
 * @param ctx The command context.
 * @param run Runs `open` / `adb` / Chrome (tests pass a fake).
 */
export async function mobileInspect(
  ctx: CommandContext,
  run: InspectRunner = captureRun,
): Promise<void> {
  const platform = inspectPlatform(ctx);
  const name = await appName(projectRoot(ctx));
  const steps = inspectSteps(platform, name ?? "the app");
  const actions = ctx.flags["dry-run"] === true
    ? []
    : await openInspector(platform, run, Deno.build.os);
  if (ctx.global.json) return console.log(JSON.stringify({ platform, steps, actions }));
  console.log(`\n  denext mobile inspect\n`);
  for (const line of steps) console.log(line === "" ? "" : `  ${line}`);
  if (actions.length > 0) console.log(["", ...actions].join("\n"));
}
