// `denext mobile add fastlane`: fastlane, for teams that already ship with it, on top of denext's
// own pipeline. `denext mobile build` / `submit` stay the zero-setup path; this writes the
// fastlane files whose lanes call `denext mobile build <platform> --release` and hand the
// artifact to match, TestFlight, the Play tracks and deliver / supply metadata
// (./fastlane-templates.ts). fastlane is Ruby dev / CI tooling: nothing reaches the app.
//
// Files carry the native templates' marker line (as a `#` comment): an unedited file is
// upgraded by a later run, an edited one is kept (`--force` replaces it). A Gemfile the project
// already had (no marker) is kept, with the one line to add as a manual step.
//
// Also here: what `denext mobile doctor --release` reports when a `fastlane/` folder exists
// (`fastlaneFindings`), read as text, never run.

import { dirname, join } from "@std/path";
import { markedTemplateIntact, renderMarkedTemplate } from "./native-template-marker.ts";
import type { NativeInstallOptions, NativeInstallReport } from "./mobile-native-install.ts";
import type { CapabilityConfig, MobileCapability } from "./mobile-capabilities.ts";
import { posixRelative } from "./mobile-paths.ts";
import { capacitorConfigFile, readCapacitorConfig } from "./capacitor-config.ts";
import {
  appfileTemplate,
  fastfileTemplate,
  FASTLANE_FILES,
  FASTLANE_VERSION,
  FASTLANE_WORKFLOW,
  gemfileTemplate,
  gitignoreTemplate,
  matchfileTemplate,
  type WorkflowInstall,
  workflowTemplate,
} from "./fastlane-templates.ts";
import { VERSION } from "../../mod.ts";

const FAMILY = "fastlane";
const TEMPLATE_VERSION = 1;
/** The id written when capacitor.config has no `appId` (a manual step says to fix it). */
const PLACEHOLDER_APP_ID = "com.example.app";

/** Options for {@linkcode addFastlaneToProject}. */
export interface AddFastlaneOptions extends NativeInstallOptions {
  /** `--ci`: also write the GitHub Actions workflow. */
  readonly ci?: boolean;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The capacitor.config `appId`, or undefined. */
async function capacitorAppId(dir: string): Promise<string | undefined> {
  const file = await capacitorConfigFile(dir);
  if (!file) return undefined;
  const config = await readCapacitorConfig(file, await Deno.readTextFile(file));
  return typeof config?.appId === "string" && config.appId !== "" ? config.appId : undefined;
}

/**
 * Write one marked file: unchanged when identical, kept when edited (unless `force`), else
 * written (an unedited earlier template is upgraded).
 */
async function writeMarked(
  dir: string,
  rel: string,
  template: string,
  force: boolean,
  report: NativeInstallReport,
  keptHint?: string,
): Promise<void> {
  const path = join(dir, rel);
  const next = await renderMarkedTemplate(FAMILY, TEMPLATE_VERSION, template, "hash");
  const current = await readText(path);
  if (current === next) return void report.unchanged.push(rel);
  if (current !== undefined && !force && (await markedTemplateIntact(FAMILY, current)) !== true) {
    report.kept.push(rel);
    report.manual.push(keptHint ?? `${rel} was edited and is kept (--force replaces it)`);
    return;
  }
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, next);
  report.written.push(rel);
  if (current !== undefined) report.upgraded.push(rel);
}

/** The nearest folder at or above `dir` holding `.git` (the repository root), or undefined. */
async function repositoryRoot(dir: string): Promise<string | undefined> {
  let at = dir;
  while (true) {
    if (await exists(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** The package manager the project's lockfile names (npm without one). */
async function workflowInstall(
  dir: string,
): Promise<{ install: WorkflowInstall; locked: boolean }> {
  const locks: ReadonlyArray<readonly [string, WorkflowInstall]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, install] of locks) {
    if (await exists(join(dir, file))) return { install, locked: true };
  }
  return { install: "npm", locked: false };
}

/** Write the workflow at the repository root (or the project, outside a repository). */
async function writeWorkflow(dir: string, force: boolean, report: NativeInstallReport) {
  const repo = (await repositoryRoot(dir)) ?? dir;
  const workingDirectory = repo === dir ? "." : posixRelative(repo, dir);
  const template = workflowTemplate({
    workingDirectory,
    ...(await workflowInstall(dir)),
    cli: `deno run -A --node-modules-dir=none jsr:@denext/denext@^${VERSION}/cli`,
  });
  const sub: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  await writeMarked(repo, FASTLANE_WORKFLOW, template, force, sub);
  // Report paths relative to the project, like every other file.
  const rel = (p: string) => posixRelative(dir, join(repo, p));
  for (const key of ["written", "upgraded", "kept", "unchanged"] as const) {
    report[key].push(...sub[key].map(rel));
  }
  report.manual.push(
    ...sub.manual.map((m) => m.replace(FASTLANE_WORKFLOW, rel(FASTLANE_WORKFLOW))),
  );
  report.manual.push(
    `add the repository secrets ${rel(FASTLANE_WORKFLOW)} lists (Settings → Secrets and ` +
      "variables → Actions)",
  );
}

/**
 * Install fastlane into a Capacitor project: `fastlane/Appfile`, `Fastfile`, `Matchfile`,
 * `.gitignore` and a `Gemfile`; with `ci`, `.github/workflows/mobile-release.yml` at the
 * repository root.
 *
 * @param opts The project root, `force` to replace edited files, `ci` for the workflow.
 * @returns What was written, kept and left to do.
 */
export async function addFastlaneToProject(opts: AddFastlaneOptions): Promise<NativeInstallReport> {
  const report: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  const force = opts.force === true;
  const found = await capacitorAppId(opts.dir);
  const appId = found ?? PLACEHOLDER_APP_ID;
  if (!found) {
    report.manual.push(
      `capacitor.config has no appId: set it, then re-run \`denext mobile add fastlane\` ` +
        `(the Appfile and Matchfile say ${PLACEHOLDER_APP_ID})`,
    );
  }
  await writeMarked(opts.dir, FASTLANE_FILES.appfile, appfileTemplate(appId), force, report);
  await writeMarked(opts.dir, FASTLANE_FILES.fastfile, fastfileTemplate(), force, report);
  await writeMarked(opts.dir, FASTLANE_FILES.matchfile, matchfileTemplate(appId), force, report);
  await writeMarked(opts.dir, FASTLANE_FILES.gitignore, gitignoreTemplate(), force, report);
  await writeMarked(
    opts.dir,
    FASTLANE_FILES.gemfile,
    gemfileTemplate(),
    force,
    report,
    `Gemfile is your own and is kept: add \`gem "fastlane", "~> ${FASTLANE_VERSION}"\` to it ` +
      "(--force replaces it with denext's)",
  );
  if (opts.ci) await writeWorkflow(opts.dir, force, report);
  if (!(await exists(join(opts.dir, "Gemfile.lock")))) {
    report.manual.push(
      "run `bundle install` here (Ruby 3.x; `bundle config set --local path vendor/bundle` " +
        "keeps the gems in the project) and commit Gemfile.lock",
    );
  }
  if (await exists(join(opts.dir, "ios"))) {
    report.manual.push(
      "iOS signing with match: create the certificate once with `MATCH_GIT_URL=… bundle exec " +
        "fastlane match appstore`; the lanes then run match read-only (MATCH_PASSWORD)",
    );
  }
  return report;
}

/** The files `add fastlane` writes, for the plan line. */
function planLabel(ci: boolean): string {
  return "fastlane/Appfile, fastlane/Fastfile (ios + android build / beta / release lanes over " +
    "`denext mobile build`), fastlane/Matchfile, fastlane/.gitignore, Gemfile (fastlane ~> " +
    `${FASTLANE_VERSION})` + (ci ? `, ${FASTLANE_WORKFLOW} (at the repository root)` : "");
}

/**
 * The `fastlane` capability of `denext mobile add`: no npm package and no native change, the
 * fastlane files installed through its `install` step.
 */
export const FASTLANE_CAPABILITY: MobileCapability = {
  capacitorMajor: 8,
  listing: "(fastlane: Ruby tooling, no plugin)",
  notes: "bundle exec fastlane ios|android build|beta|release [flavor:<name>] (lanes over " +
    "`denext mobile build`: match, TestFlight, Play tracks, metadata; --ci adds a GitHub " +
    "Actions workflow)",
  options: ["ci"],
  configure: (options): CapabilityConfig => ({
    install: {
      label: planLabel(options.ci === true),
      run: (opts) => addFastlaneToProject({ ...opts, ci: options.ci === true }),
    },
  }),
};

// ---- doctor ------------------------------------------------------------------------------------

/** One fastlane problem, with its fix (the doctor adds its check id). */
export interface FastlaneFinding {
  readonly level: "error" | "warning";
  readonly message: string;
  readonly fix: string;
}

/** The literal app id an Appfile sets with `method("…")`, or undefined. */
function appfileValue(appfile: string, method: string): string | undefined {
  const re = new RegExp(`^\\s*${method}\\s*\\(?\\s*["']([^"']+)["']`, "m");
  return re.exec(appfile)?.[1];
}

/** Whether `appfile` calls `method` at all (with a literal, an ENV lookup, …). */
function appfileSets(appfile: string, method: string): boolean {
  return new RegExp(`^\\s*${method}\\b`, "m").test(appfile);
}

/** Files under `fastlane/` that hold signing or service-account secrets. */
async function secretFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const name = entry.name;
    if (/\.(p8|p12|cer|mobileprovision|jks|keystore)$/.test(name)) out.push(name);
    else if (name.endsWith(".json")) {
      const text = await readText(join(dir, name));
      if (text?.includes('"private_key"')) out.push(name);
    } else if (/^\.env(\.|$)/.test(name)) {
      const text = await readText(join(dir, name));
      if (text && /^\s*[A-Z0-9_]*(PASSWORD|_KEY|TOKEN|SECRET)[A-Z0-9_]*\s*=\s*\S/m.test(text)) {
        out.push(name);
      }
    }
  }
  return out.sort();
}

/** Appfile findings: missing, or an app id that is not capacitor.config's. */
function appfileFindings(appfile: string | undefined, appId: string | undefined) {
  if (appfile === undefined) {
    return [{
      level: "warning" as const,
      message: "fastlane/ has no Appfile, so every lane needs app_identifier / package_name passed",
      fix: "re-run `denext mobile add fastlane` (writes it from capacitor.config appId)",
    }];
  }
  const out: FastlaneFinding[] = [];
  for (const method of ["app_identifier", "package_name"]) {
    const value = appfileValue(appfile, method);
    if (value !== undefined && appId !== undefined && value !== appId) {
      out.push({
        level: "error",
        message: `fastlane/Appfile ${method} is "${value}" but capacitor.config appId is ` +
          `"${appId}": uploads and match would target another app`,
        fix: `set ${method}("${appId}") (or re-run \`denext mobile add fastlane --force\`)`,
      });
    } else if (!appfileSets(appfile, method)) {
      out.push({
        level: "warning",
        message: `fastlane/Appfile does not set ${method}`,
        fix: `add ${method}("${appId ?? "<app id>"}") to fastlane/Appfile`,
      });
    }
  }
  return out;
}

/** Gemfile findings: fastlane run outside bundler, or without a lockfile. */
function gemfileFindings(gemfile: string | undefined, locked: boolean): FastlaneFinding[] {
  if (gemfile === undefined) {
    return [{
      level: "warning",
      message: "no Gemfile next to fastlane/, so each machine and CI runs whatever fastlane " +
        "it has installed",
      fix: `add a Gemfile with gem "fastlane", "~> ${FASTLANE_VERSION}" (\`denext mobile add ` +
        "fastlane` writes one), `bundle install`, and run `bundle exec fastlane`",
    }];
  }
  if (!/^\s*gem\s+["']fastlane["']/m.test(gemfile)) {
    return [{
      level: "warning",
      message: "the Gemfile does not list fastlane",
      fix: `add gem "fastlane", "~> ${FASTLANE_VERSION}" and run \`bundle install\``,
    }];
  }
  if (locked) return [];
  return [{
    level: "warning",
    message: "Gemfile has no Gemfile.lock, so fastlane's version (and its dependencies') " +
      "differs between machines and CI",
    fix: "run `bundle install` and commit Gemfile.lock",
  }];
}

/** A Fastfile that builds with gym / gradle itself skips `denext export` and `cap sync`. */
function fastfileFindings(fastfile: string | undefined): FastlaneFinding[] {
  if (fastfile === undefined) {
    return [{
      level: "warning",
      message: "fastlane/ has no Fastfile",
      fix: "re-run `denext mobile add fastlane` (lanes over `denext mobile build`)",
    }];
  }
  const nativeBuild = /^\s*(gym|build_app|build_ios_app|gradle|build_android_app)\b/m.test(
    fastfile,
  );
  if (!nativeBuild || /\bmobile\b.*\bbuild\b|denext_build/.test(fastfile)) return [];
  return [{
    level: "warning",
    message: "fastlane/Fastfile builds with gym / gradle directly: without `denext export` and " +
      "`npx cap sync` first, the binary can carry a stale web UI",
    fix: "build with `denext mobile build <platform> --release` (the generated lanes do), or " +
      "run `denext export` and `npx cap sync` in the lane before gym / gradle",
  }];
}

/** Credentials written into fastlane's Ruby files (a token in a git URL, a literal password). */
function inlineSecretFindings(texts: Record<string, string | undefined>): FastlaneFinding[] {
  const out: FastlaneFinding[] = [];
  for (const [name, text] of Object.entries(texts)) {
    if (text === undefined) continue;
    const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    if (/:\/\/[^/\s"'@:]+:[^/\s"'@]+@/.test(code)) {
      out.push({
        level: "error",
        message: `fastlane/${name} has a credential in a URL (https://user:token@…)`,
        fix: "use the plain URL and pass the token in the environment " +
          "(MATCH_GIT_BASIC_AUTHORIZATION for match)",
      });
    }
    if (
      /\b(MATCH_PASSWORD|FASTLANE_PASSWORD|[A-Z_]*KEYSTORE_PASSWORD)\b["']?\]?\s*=\s*["']/.test(
        code,
      )
    ) {
      out.push({
        level: "error",
        message: `fastlane/${name} assigns a password literal`,
        fix: "set it in the environment (a CI secret) instead",
      });
    }
  }
  return out;
}

/**
 * What `denext mobile doctor --release` reports about a project's fastlane setup: the Appfile's
 * identifiers against capacitor.config, the Gemfile and its lock, a Fastfile that skips denext's
 * export and sync, and secrets kept in `fastlane/`. Undefined when there is no `fastlane/`.
 *
 * @param root The Capacitor project.
 * @param appId capacitor.config's `appId`, when known.
 */
export async function fastlaneFindings(
  root: string,
  appId: string | undefined,
): Promise<FastlaneFinding[] | undefined> {
  const dir = join(root, "fastlane");
  try {
    if (!(await Deno.stat(dir)).isDirectory) return undefined;
  } catch {
    return undefined;
  }
  const appfile = await readText(join(dir, "Appfile"));
  const fastfile = await readText(join(dir, "Fastfile"));
  const matchfile = await readText(join(dir, "Matchfile"));
  const secrets = await secretFiles(dir);
  return [
    ...appfileFindings(appfile, appId),
    ...gemfileFindings(
      await readText(join(root, "Gemfile")),
      await exists(join(root, "Gemfile.lock")),
    ),
    ...fastfileFindings(fastfile),
    ...inlineSecretFindings({ Appfile: appfile, Fastfile: fastfile, Matchfile: matchfile }),
    ...secrets.map((name): FastlaneFinding => ({
      level: "warning",
      message: `fastlane/${name} holds a signing or service-account secret`,
      fix: "keep it out of git (fastlane/.gitignore lists key files) and give CI its contents " +
        "as a secret (SUPPLY_JSON_KEY_DATA, APP_STORE_CONNECT_API_KEY_KEY, MATCH_PASSWORD)",
    })),
  ];
}
