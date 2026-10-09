// `denext migrate --enable-capacitor`: give a migrated app an iOS / Android Capacitor target,
// the way `--desktop` gives it a desktop one.
//
// This module only READS the project and computes the plan; migrate.ts writes the files
// (`capacitor.config.ts`, the `mobile:*` tasks, the `.gitignore` lines, `spa.precompress: false`
// and `mobile.icon`), and the CLI runs the steps (the package install, and with `--platform` the
// export and `npx cap add`). Keeping the commands out of `migrateProject` is what lets
// `denext migrate --check` list them without running anything.

import { join } from "@std/path";
import { mfs } from "./migrate-io.ts";
import { exists, firstExisting } from "./migrate-fs.ts";
import { CAPACITOR_CONFIGS, readCapacitorConfig } from "./capacitor-config.ts";
import {
  CAPACITOR_BUILD_IGNORES,
  CAPACITOR_VERSION,
  YARN_NO_SCRIPTS_ENV,
} from "./capacitor-pins.ts";
import type { CommandRunner, PlannedCommand } from "./mobile-capabilities.ts";

/** A native platform Capacitor adds. */
export type CapacitorPlatform = "ios" | "android";

/** The platforms `--platform` accepts, in the order the steps run. */
const CAPACITOR_PLATFORMS: readonly CapacitorPlatform[] = ["ios", "android"];

/** The folder denext's export writes, which the shell bundles (`webDir`). */
const CAPACITOR_WEB_DIR = "out";

/** The package managers migrate detects from a lockfile. */
export type MigratePackageManager = "pnpm" | "yarn" | "npm" | "bun";

/** Something the Capacitor target leaves to the user, with the reason. */
export interface CapacitorFinding {
  /** What it concerns: a file, an env key, the backend. */
  item: string;
  /** Why, and what to do about it. */
  reason: string;
}

/** A command the Capacitor target runs after the files are written. */
export interface CapacitorStep {
  /** What it does: `install`, `export`, `add ios`, `add android`. */
  label: string;
  /** The command. */
  command: PlannedCommand;
  /** The command as one shell line, for the report (and for the user to run by hand). */
  line: string;
  /** Why migrate does not run it (the line is printed for the user instead). */
  skip?: string;
}

/** Where the app id came from. */
export type AppIdSource =
  | "--app-id"
  | "capacitor config"
  | "app config"
  | "desktop identifier"
  | "package name";

/** What `--enable-capacitor` planned and wrote. */
export interface CapacitorMigrateInfo {
  /** The bundle id / Android package name. */
  appId: string;
  appName: string;
  appIdSource: AppIdSource;
  /** The id was derived (from the package name), so it needs a human look. */
  placeholderId: boolean;
  /** The export folder the shell bundles. */
  webDir: string;
  /** `capacitor.config.ts` was written (false: a hand-authored config was kept). */
  configWritten: boolean;
  /** The kept config file, when one existed. */
  existingConfig?: string;
  /** The `@capacitor/*` packages to install (`name@range`; empty when all are there). */
  packages: string[];
  /** The platforms `--platform` asked for. */
  platforms: CapacitorPlatform[];
  /** The commands to run, in order (the install, then the export and `cap add` per platform). */
  steps: CapacitorStep[];
  /** What migrate cannot know, for the user to check. */
  review: CapacitorFinding[];
}

/** The `--enable-capacitor` options. */
export interface CapacitorOptions {
  /** `--app-id`: the bundle id (reverse-DNS, as Capacitor requires). */
  appId?: string;
  /** `--platform`: run `cap add` for these after the install. */
  platforms?: readonly string[];
}

/** What the migration path knows about the app, for {@linkcode planCapacitor}. */
export interface CapacitorPlanInput {
  dir: string;
  /** The app's dependencies and devDependencies. */
  deps: Record<string, string>;
  pm: MigratePackageManager | null;
  /** The denext CLI specifier the generated tasks run. */
  cli: string;
  /** The `deno run …` prefix the generated tasks use for the CLI. */
  run: string;
  /** The app's display name. */
  appName: string;
  /** package.json `name`, for a derived app id. */
  packageName?: string;
  /** Which migration path: a SPA, a Next App Router app, or an Expo app. */
  kind: "spa" | "app-router" | "expo";
  /** The build-time env keys the app reads (SPA). */
  envKeys?: readonly string[];
  /** The app's dev proxy prefixes, or the vite.config that builds them in code (SPA). */
  devProxy?: { prefixes?: string[]; computed?: string };
  /** Files that need a server (App Router route handlers, Server Actions). */
  serverFiles?: readonly string[];
  /** The Expo app config's id: its bundle identifier, or (`placeholder`) one made from its slug. */
  appConfigId?: { appId: string; placeholder: boolean };
  options: CapacitorOptions;
}

/** What {@linkcode planCapacitor} returns: the report, and what migrate writes. */
export interface CapacitorPlan {
  /** The report, minus `configWritten` (known once migrate writes). */
  info: Omit<CapacitorMigrateInfo, "configWritten">;
  /** The `mobile:*` deno tasks. */
  tasks: Record<string, string>;
  /** The `.gitignore` lines (the native build outputs). */
  ignores: string[];
  /** Write `capacitor.config.ts` (false when a config of another name is kept). */
  writeConfig: boolean;
}

/** A Capacitor app id: Java package form (Android's rule, which Capacitor enforces). */
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Whether `id` is a valid Capacitor app id. */
function isCapacitorAppId(id: string): boolean {
  return APP_ID.test(id);
}

/**
 * Check the `--enable-capacitor` options before anything is written.
 *
 * @throws {Error} When `--app-id` is not a valid app id or `--platform` names another platform.
 */
export function validateCapacitorOptions(options: CapacitorOptions): void {
  if (options.appId !== undefined && !isCapacitorAppId(options.appId)) {
    throw new Error(
      `--app-id ${JSON.stringify(options.appId)} is not a valid app id: use reverse-DNS ` +
        "segments of letters, digits and underscores, each starting with a letter " +
        "(e.g. com.example.app; Android allows no hyphens)",
    );
  }
  for (const p of options.platforms ?? []) {
    if (!CAPACITOR_PLATFORMS.includes(p as CapacitorPlatform)) {
      throw new Error(`--platform ${JSON.stringify(p)}: pass ios, android, or both (ios,android)`);
    }
  }
}

/** A reverse-DNS id segment from free text (`"T3 Code"` → `"t3code"`). */
function idSegment(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(s) ? s : `app${s}`;
}

/** An app id derived from the package name: `@acme/web` → `com.acme.web`, `web` → `com.example.web`. */
export function appIdFromPackageName(name: string | undefined, appName: string): string {
  const scoped = name ? /^@([^/]+)\/(.+)$/.exec(name) : null;
  if (scoped) return `com.${idSegment(scoped[1])}.${idSegment(scoped[2])}`;
  return `com.example.${idSegment(name || appName)}`;
}

/** `desktop.app.identifier` from deno.json, or from a denext.config literal. */
async function desktopIdentifier(dir: string): Promise<string | undefined> {
  try {
    const deno = JSON.parse(await mfs.readTextFile(join(dir, "deno.json")));
    const id = deno?.desktop?.app?.identifier;
    if (typeof id === "string" && isCapacitorAppId(id)) return id;
  } catch { /* no deno.json, or not JSON */ }
  for (const name of ["denext.config.ts", "denext.config.js", "denext.config.mjs"]) {
    const text = await mfs.readTextFile(join(dir, name)).catch(() => "");
    const m = /\bidentifier\s*:\s*["']([^"']+)["']/.exec(text);
    if (m && isCapacitorAppId(m[1])) return m[1];
  }
  return undefined;
}

/** The kept Capacitor config, its literal values, and whether migrate may rewrite it. */
async function existingConfig(
  dir: string,
): Promise<{ file: string; values: Record<string, unknown> | null; generated: boolean } | null> {
  const file = await firstExisting(dir, [...CAPACITOR_CONFIGS]);
  if (!file) return null;
  const text = await mfs.readTextFile(join(dir, file)).catch(() => "");
  return {
    file,
    values: await readCapacitorConfig(file, text).catch(() => null),
    generated: file === "capacitor.config.ts" && text.includes("generated by `denext migrate`"),
  };
}

/** The app id and where it came from, in precedence order. */
async function resolveAppId(
  input: CapacitorPlanInput,
  kept: Record<string, unknown> | null,
): Promise<{ appId: string; appIdSource: AppIdSource; placeholderId: boolean }> {
  const flag = input.options.appId;
  if (flag) return { appId: flag, appIdSource: "--app-id", placeholderId: false };
  if (typeof kept?.appId === "string") {
    return { appId: kept.appId, appIdSource: "capacitor config", placeholderId: false };
  }
  const fromConfig = input.appConfigId;
  if (fromConfig && !fromConfig.placeholder) {
    return { appId: fromConfig.appId, appIdSource: "app config", placeholderId: false };
  }
  const desktop = await desktopIdentifier(input.dir);
  if (desktop) return { appId: desktop, appIdSource: "desktop identifier", placeholderId: false };
  if (fromConfig) {
    return { appId: fromConfig.appId, appIdSource: "app config", placeholderId: true };
  }
  return {
    appId: appIdFromPackageName(input.packageName, input.appName),
    appIdSource: "package name",
    placeholderId: true,
  };
}

/** The `@capacitor/*` packages the app lacks: the CLI, core, and each platform's. */
function missingPackages(
  deps: Record<string, string>,
  platforms: readonly CapacitorPlatform[],
): string[] {
  const wanted = ["cli", "core", ...platforms].map((p) => `@capacitor/${p}`);
  return wanted.filter((name) => !(name in deps)).map((name) => `${name}@${CAPACITOR_VERSION}`);
}

/**
 * The install command for `specs` as dev dependencies. It never runs the project's own
 * lifecycle scripts (a monorepo's `prepare`, a `postinstall`): the Capacitor packages need no
 * install script. npm, pnpm and bun take `--ignore-scripts`; Yarn gets
 * {@link YARN_NO_SCRIPTS_ENV}.
 */
function installCommand(
  pm: MigratePackageManager,
  specs: string[],
  cwd: string,
): PlannedCommand {
  if (pm === "yarn") {
    return { cmd: pm, args: ["add", "-D", ...specs], cwd, env: YARN_NO_SCRIPTS_ENV };
  }
  const args = pm === "npm"
    ? ["install", "-D", "--ignore-scripts"]
    : ["add", "-D", "--ignore-scripts"];
  return { cmd: pm, args: [...args, ...specs], cwd };
}

/** A command as one shell line (env assignments first; arguments with spaces or quotes quoted). */
function commandLine(c: PlannedCommand): string {
  const quote = (a: string) => (/^[\w@^.:/=,+-]+$/.test(a) ? a : JSON.stringify(a));
  const env = Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`);
  return [...env, ...[c.cmd, ...c.args].map(quote)].join(" ");
}

/** A step from a command. */
function step(label: string, command: PlannedCommand, skip?: string): CapacitorStep {
  return { label, command, line: commandLine(command), ...(skip ? { skip } : {}) };
}

/** The install, export and `cap add` steps. */
async function capacitorSteps(
  input: CapacitorPlanInput,
  packages: string[],
  platforms: CapacitorPlatform[],
): Promise<CapacitorStep[]> {
  const { dir, pm } = input;
  const steps: CapacitorStep[] = [];
  if (packages.length) {
    steps.push(
      pm ? step("install", installCommand(pm, packages, dir)) : step(
        "install",
        installCommand("npm", packages, dir),
        "no lockfile, so migrate does not pick a package manager: run this, or your " +
          "manager's equivalent",
      ),
    );
  }
  if (platforms.length === 0) return steps;
  const notInstalled = packages.length > 0 && !pm
    ? "the Capacitor packages are not installed yet; run it after the install"
    : undefined;
  steps.push(step(
    "export",
    { cmd: "deno", args: [...input.run.split(" ").slice(1), input.cli, "export", "."], cwd: dir },
    notInstalled,
  ));
  for (const p of platforms) {
    const there = await exists(join(dir, p)) ? `${p}/ already exists` : undefined;
    steps.push(
      step(`add ${p}`, { cmd: "npx", args: ["cap", "add", p], cwd: dir }, there ?? notInstalled),
    );
  }
  return steps;
}

/**
 * The `mobile:*` tasks a Capacitor target gets: export + OTA stamp + `cap sync`, open each
 * native IDE, and a signed store build per platform. `cap` runs the app's installed Capacitor
 * CLI (`npx cap`, as `denext mobile` does) when a package manager installs it, else Capacitor's
 * CLI from Deno's npm cache.
 */
export function capacitorTasks(
  cli: string,
  o: { run: string; installed: boolean },
): Record<string, string> {
  const cap = o.installed
    ? "npx cap"
    : `deno run -A --node-modules-dir npm:@capacitor/cli@${CAPACITOR_VERSION}`;
  return {
    "mobile:sync": `deno task export && ${o.run} ${cli} ota manifest out && ${cap} sync`,
    "mobile:ios": `${cap} open ios`,
    "mobile:android": `${cap} open android`,
    "mobile:build:ios": `${o.run} ${cli} mobile build ios`,
    "mobile:build:android": `${o.run} ${cli} mobile build android`,
  };
}

/** Env keys that look like a build-time mode switch (hosted / remote / channel). */
const MODE_KEY = /(HOSTED|REMOTE|CHANNEL|MODE|TARGET|PLATFORM|ENVIRONMENT)/;
/** Env keys that look like a backend address. */
const URL_KEY = /(_URL|_URI|_HOST|_ORIGIN|_ENDPOINT|API_BASE)$/;

/** The SPA's build-time env keys a phone build may need set differently. */
function envFindings(keys: readonly string[]): CapacitorFinding[] {
  const urls = keys.filter((k) => URL_KEY.test(k));
  const modes = keys.filter((k) => !URL_KEY.test(k) && MODE_KEY.test(k));
  const out: CapacitorFinding[] = [];
  if (modes.length) {
    out.push({
      item: `build-time switches: ${modes.join(", ")}`,
      reason: "baked into the export when it is built; if the phone app runs in another mode " +
        "(hosted / remote), set them in the environment of `deno task mobile:sync` / " +
        "`denext mobile build`",
    });
  }
  if (urls.length) {
    out.push({
      item: `backend addresses: ${urls.join(", ")}`,
      reason: "a phone cannot reach localhost or a LAN-only host: build the phone export with " +
        "these pointing at a server the phone can reach",
    });
  }
  return out;
}

/** Relative requests have no server in the shell; the backend must allow the shell's origins. */
function backendFindings(input: CapacitorPlanInput): CapacitorFinding[] {
  const proxy = input.devProxy?.prefixes?.length
    ? ` (the dev proxy's ${input.devProxy.prefixes.join(", ")})`
    : input.devProxy?.computed
    ? ` (the dev proxy in ${input.devProxy.computed})`
    : "";
  return [
    {
      item: "backend URL",
      reason: "the shell serves the export from capacitor://localhost (iOS) and " +
        `https://localhost (Android), so relative requests${proxy} reach no server there and ` +
        "spa.proxy is desktop-only: call the backend at an absolute URL the phone can reach",
    },
    {
      item: "CORS",
      reason: "the backend must allow the origins capacitor://localhost and https://localhost " +
        "(credentials too, if it uses cookies); a denext backend sets `cors` in denext.config.ts",
    },
  ];
}

/** An App Router export: server-only files, and the multi-page routing the shell needs. */
function appRouterFindings(input: CapacitorPlanInput): CapacitorFinding[] {
  const out: CapacitorFinding[] = [];
  const files = input.serverFiles ?? [];
  if (files.length) {
    const named = files.slice(0, 5).join(", ") + (files.length > 5 ? `, +${files.length - 5}` : "");
    out.push({
      item: `server code: ${named}`,
      reason: "the shell bundles the static export, so route handlers, Server Actions and " +
        "per-request rendering do not run in it: serve them from a deployed denext backend " +
        "and call it at its URL",
    });
  }
  out.push({
    item: "export-routes",
    reason: "Capacitor answers every path with the root index.html; after `cap add`, run " +
      "`denext mobile add export-routes` so /about serves about/index.html",
  });
  return out;
}

/** A derived app id, and a kept config whose webDir is not the export. */
function configFindings(
  input: CapacitorPlanInput,
  id: { appId: string; placeholderId: boolean },
  kept: { file: string; values: Record<string, unknown> | null; generated: boolean } | null,
): CapacitorFinding[] {
  const out: CapacitorFinding[] = [];
  // An Expo app's placeholder id is already an Expo finding.
  if (id.placeholderId && input.kind !== "expo") {
    out.push({
      item: "capacitor.config.ts",
      reason: `appId ${id.appId} is derived from the package name: set the real bundle id ` +
        "before `cap add` (it becomes the iOS bundle id and the Android package name), or " +
        "re-run with --app-id",
    });
  }
  if (!kept || kept.generated) return out;
  const webDir = kept.values?.webDir;
  if (webDir !== CAPACITOR_WEB_DIR) {
    out.push({
      item: kept.file,
      reason: `kept as is, but its webDir is ${JSON.stringify(webDir ?? null)}: set it to ` +
        `"${CAPACITOR_WEB_DIR}", where \`denext export\` writes`,
    });
  }
  return out;
}

/** What the user must check: the app id, the kept config, and the backend / env / export. */
function reviewFindings(
  input: CapacitorPlanInput,
  id: { appId: string; placeholderId: boolean },
  kept: { file: string; values: Record<string, unknown> | null; generated: boolean } | null,
): CapacitorFinding[] {
  const out = [...configFindings(input, id, kept)];
  if (input.kind === "expo") return out;
  out.push(...envFindings(input.envKeys ?? []));
  out.push(...backendFindings(input));
  if (input.kind === "app-router") out.push(...appRouterFindings(input));
  return out;
}

/**
 * Plan the Capacitor target for a migrated app.
 *
 * @param input What the migration path knows about the app, and the options.
 * @returns The report, the tasks and `.gitignore` lines, and whether to write the config.
 */
export async function planCapacitor(input: CapacitorPlanInput): Promise<CapacitorPlan> {
  const platforms = CAPACITOR_PLATFORMS.filter((p) => input.options.platforms?.includes(p));
  const kept = await existingConfig(input.dir);
  const keptValues = kept && !kept.generated ? kept.values : null;
  const id = await resolveAppId(input, keptValues);
  const appName = typeof keptValues?.appName === "string" ? keptValues.appName : input.appName;
  // Both platforms' packages unless --platform narrows them: each is only JS, and the
  // `mobile:*` tasks name both.
  const packages = missingPackages(
    input.deps,
    platforms.length ? platforms : CAPACITOR_PLATFORMS,
  );
  return {
    info: {
      ...id,
      appName,
      webDir: CAPACITOR_WEB_DIR,
      ...(kept && !kept.generated ? { existingConfig: kept.file } : {}),
      packages,
      platforms,
      steps: await capacitorSteps(input, packages, platforms),
      review: reviewFindings(input, id, kept),
    },
    tasks: capacitorTasks(input.cli, { run: input.run, installed: input.pm !== null }),
    ignores: [...CAPACITOR_BUILD_IGNORES],
    writeConfig: !kept || kept.generated,
  };
}

/** App Router files that need a server: route handlers and `"use server"` modules. */
export async function appRouterServerFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    try {
      for await (const e of mfs.readDir(join(dir, rel))) {
        const path = `${rel}/${e.name}`;
        if (e.isDirectory) {
          if (e.name !== "node_modules") await walk(path);
        } else if (/^route\.(tsx?|jsx?|mjs)$/.test(e.name)) {
          found.push(path);
        } else if (/\.(tsx?|jsx?|mjs)$/.test(e.name)) {
          const text = await mfs.readTextFile(join(dir, path)).catch(() => "");
          if (/^\s*["']use server["']/.test(text)) found.push(path);
        }
      }
    } catch { /* no such folder */ }
  };
  for (const root of ["app", "src/app"]) await walk(root);
  return found.sort();
}

/** How the CLI's run of the steps went. */
export interface CapacitorStepsOutcome {
  /** The lines that ran and succeeded. */
  ran: string[];
  /** The step that failed, and its exit code. */
  failed?: { line: string; code: number };
  /** Steps not run: skipped ones (with the reason), and every step after a failure. */
  pending: Array<{ line: string; reason: string }>;
}

/**
 * Run the planned steps in order. A skipped step is left to the user; a failed step stops the
 * run, and the rest are left to the user too.
 *
 * @param steps The plan's steps.
 * @param run Runs one command and resolves its exit code.
 */
export async function runCapacitorSteps(
  steps: readonly CapacitorStep[],
  run: CommandRunner,
): Promise<CapacitorStepsOutcome> {
  const out: CapacitorStepsOutcome = { ran: [], pending: [] };
  for (const s of steps) {
    if (out.failed) {
      out.pending.push({ line: s.line, reason: "not run: an earlier step failed" });
      continue;
    }
    if (s.skip) {
      out.pending.push({ line: s.line, reason: s.skip });
      continue;
    }
    const { code } = await run(s.command);
    if (code === 0) out.ran.push(s.line);
    else out.failed = { line: s.line, code };
  }
  return out;
}
