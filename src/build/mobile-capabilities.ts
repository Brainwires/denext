// `denext mobile add <capability...>`: install the Capacitor plugins behind denext/mobile's
// capability functions (haptic(), share(), secureStore, …) into an existing Capacitor project.
// It finds the project (the folder holding capacitor.config.*), refuses when the installed
// @capacitor/core major is not the one the pinned plugins target, adds the npm packages with
// the project's own package manager, writes any Info.plist keys and Android permissions the
// capability needs, and runs `npx cap sync`. Every subprocess goes through a runner the caller
// passes in, so tests never spawn a real install.

import { join, resolve } from "@std/path";
import { withManifestPermission, withPlistDefault } from "./mobile-native-config.ts";

/** One capability: the npm package behind it and the native config it needs. */
export interface MobileCapability {
  /** The npm package that provides the native plugin. */
  readonly npm: string;
  /** The version range added (`<npm>@<version>`), pinned to the plugin's Capacitor major. */
  readonly version: string;
  /** The `@capacitor/core` major the pinned plugin targets. */
  readonly capacitorMajor: number;
  /** Info.plist string keys to add when absent (key → default value; an app's own wins). */
  readonly iosPlist?: Readonly<Record<string, string>>;
  /** Android permissions to declare in AndroidManifest.xml (full names). */
  readonly androidPermissions?: readonly string[];
  /** A one-line note printed with the plan. */
  readonly notes?: string;
}

/** The Capacitor major every pinned plugin below targets. */
const CAPACITOR_MAJOR = 8;

/**
 * Every capability `denext mobile add` knows, keyed by the name on its command line. Ranges
 * are the plugins' Capacitor 8 majors (each declares `@capacitor/core >=8.0.0`).
 */
export const MOBILE_CAPABILITIES: Readonly<Record<string, MobileCapability>> = {
  haptics: {
    npm: "@capacitor/haptics",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "haptic(kind)",
  },
  clipboard: {
    npm: "@capacitor/clipboard",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "readClipboard() / writeClipboard(text)",
  },
  share: {
    npm: "@capacitor/share",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "share({ title, text, url })",
  },
  device: {
    npm: "@capacitor/device",
    version: "^8.0.3",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "deviceInfo()",
  },
  network: {
    npm: "@capacitor/network",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    androidPermissions: ["android.permission.ACCESS_NETWORK_STATE"],
    notes: "networkStatus() / useNetworkStatus()",
  },
  "keep-awake": {
    npm: "@capacitor-community/keep-awake",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "useKeepAwake(active)",
  },
  splash: {
    npm: "@capacitor/splash-screen",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "hideSplash() (set SplashScreen.launchAutoHide: false in capacitor.config)",
  },
  "secure-store": {
    npm: "@aparajita/capacitor-secure-storage",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "secureStore.get / set / delete (Keychain / Keystore)",
  },
  browser: {
    npm: "@capacitor/browser",
    version: "^8.0.4",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "openExternal(url) in the in-app browser",
  },
};

/** A package manager `denext mobile add` can drive. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** A subprocess to run: `cmd args…` in `cwd`. */
export interface PlannedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Runs a {@linkcode PlannedCommand} and resolves its exit code. */
export type CommandRunner = (command: PlannedCommand) => Promise<{ code: number }>;

/** What `denext mobile add` will do, computed without touching anything. */
export interface CapabilityPlan {
  /** The Capacitor project root. */
  readonly root: string;
  /** The capabilities, deduplicated, in command-line order. */
  readonly capabilities: readonly string[];
  /** The detected package manager, and the lockfile it came from (none: npm by default). */
  readonly packageManager: PackageManager;
  readonly lockfile?: string;
  /** The `@capacitor/core` major found, and where it was read. */
  readonly capacitorMajor: number;
  readonly capacitorSource: "installed" | "package.json";
  /** The package install, then `cap sync`. */
  readonly install: PlannedCommand;
  readonly sync: PlannedCommand;
  /** Info.plist keys to add when absent. */
  readonly plist: ReadonlyArray<{ key: string; value: string }>;
  /** Android permissions to declare. */
  readonly permissions: readonly string[];
  /** Notes for each capability (`name: note`). */
  readonly notes: readonly string[];
}

/** What {@linkcode addMobileCapabilities} did, as project-relative paths and notes. */
export interface AddCapabilitiesReport {
  readonly plan: CapabilityPlan;
  /** Native config files changed. */
  readonly written: string[];
  /** Native config files already as they would be written. */
  readonly unchanged: string[];
  /** Platforms or edits skipped, with the reason. */
  readonly skipped: string[];
  /** The commands run, each as one line (empty for a dry run). */
  readonly ran: string[];
}

/** Options for {@linkcode planMobileCapabilities} and {@linkcode addMobileCapabilities}. */
export interface AddCapabilitiesOptions {
  /** The capability names from the command line. */
  readonly capabilities: readonly string[];
  /** The working directory: the project when `dir` is absent, and what `dir` resolves against. */
  readonly cwd: string;
  /** `--dir`: the Capacitor project. When given it is the only place looked (no `cwd` fallback). */
  readonly dir?: string;
  /** Plan only: print it, change nothing, run nothing. */
  readonly dryRun?: boolean;
  /** Runs the install and sync (required unless `dryRun`). */
  readonly run?: CommandRunner;
  /** The capability table (tests); defaults to {@linkcode MOBILE_CAPABILITIES}. */
  readonly table?: Readonly<Record<string, MobileCapability>>;
}

const CAPACITOR_CONFIGS = [
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.mjs",
  "capacitor.config.cjs",
  "capacitor.config.json",
];
const INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";

/** Lockfile → package manager, in detection order. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
];

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/** Whether `dir` holds a `capacitor.config.*`. */
async function isCapacitorProject(dir: string): Promise<boolean> {
  for (const name of CAPACITOR_CONFIGS) if (await exists(join(dir, name))) return true;
  return false;
}

/**
 * The project root: `dir` resolved against `cwd` when given, else `cwd`. It must hold a
 * `capacitor.config.*` and a `package.json`. An explicit `dir` never falls back to `cwd`:
 * a mistyped `--dir` would otherwise change whichever project the shell happens to be in.
 */
async function findProject(cwd: string, dir: string | undefined): Promise<string> {
  const root = dir === undefined ? cwd : resolve(cwd, dir);
  if (!(await isCapacitorProject(root))) {
    throw new Error(
      dir === undefined
        ? `no Capacitor project (capacitor.config.*) in ${root}. Pass --dir <the Capacitor project>.`
        : `--dir ${dir}: no Capacitor project (capacitor.config.*) in ${root}.`,
    );
  }
  if (!(await exists(join(root, "package.json")))) {
    throw new Error(`${root} has a capacitor.config but no package.json.`);
  }
  return root;
}

/** The leading major of a version or a range (`8.5.2`, `^8.0.0`, `~8.1`, `>=8`). */
function majorOf(version: string): number | undefined {
  const m = /(\d+)/.exec(version);
  return m ? Number(m[1]) : undefined;
}

/** The `@capacitor/core` major: the installed package first, else package.json's range. */
async function capacitorCore(
  root: string,
): Promise<{ major: number; source: "installed" | "package.json" }> {
  const installed = await readText(
    join(root, "node_modules", "@capacitor", "core", "package.json"),
  );
  const installedMajor = installed === undefined
    ? undefined
    : majorOf(String((JSON.parse(installed) as { version?: unknown }).version ?? ""));
  if (installedMajor !== undefined) return { major: installedMajor, source: "installed" };
  const pkg = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as Record<
    string,
    Record<string, string> | undefined
  >;
  const range = pkg.dependencies?.["@capacitor/core"] ?? pkg.devDependencies?.["@capacitor/core"];
  const declaredMajor = range === undefined ? undefined : majorOf(range);
  if (declaredMajor === undefined) {
    throw new Error(`${root} does not depend on @capacitor/core (is it a Capacitor project?).`);
  }
  return { major: declaredMajor, source: "package.json" };
}

/** The package manager, from the first lockfile found; npm without one. */
async function detectPackageManager(
  root: string,
): Promise<{ manager: PackageManager; lockfile?: string }> {
  for (const [lockfile, manager] of LOCKFILES) {
    if (await exists(join(root, lockfile))) return { manager, lockfile };
  }
  return { manager: "npm" };
}

/** `manager`'s command to add `specs` as dependencies. */
function addCommand(manager: PackageManager, specs: string[], cwd: string): PlannedCommand {
  const verb = manager === "npm" ? "install" : "add";
  return { cmd: manager, args: [verb, ...specs], cwd };
}

/** The capability names, deduplicated, refusing unknown ones. */
function pickCapabilities(
  names: readonly string[],
  table: Readonly<Record<string, MobileCapability>>,
): string[] {
  if (names.length === 0) {
    throw new Error(`name at least one capability (${Object.keys(table).join(", ")}).`);
  }
  const unknown = names.filter((n) => !Object.hasOwn(table, n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown capability ${unknown.map((n) => `"${n}"`).join(", ")} (known: ${
        Object.keys(table).join(", ")
      }).`,
    );
  }
  return [...new Set(names)];
}

/**
 * Work out what `denext mobile add` will do, without changing anything: the project root,
 * its package manager, the install and sync commands, and the native config edits. It throws
 * for an unknown capability, a folder without a Capacitor project, and an `@capacitor/core`
 * major other than the one the chosen plugins target.
 *
 * @param opts The capability names and where to look.
 * @returns The plan.
 */
export async function planMobileCapabilities(
  opts: AddCapabilitiesOptions,
): Promise<CapabilityPlan> {
  const table = opts.table ?? MOBILE_CAPABILITIES;
  const names = pickCapabilities(opts.capabilities, table);
  const root = await findProject(opts.cwd, opts.dir);
  const core = await capacitorCore(root);
  const mismatched = names.filter((n) => table[n].capacitorMajor !== core.major);
  if (mismatched.length > 0) {
    const wanted = [...new Set(mismatched.map((n) => table[n].capacitorMajor))].join(" / ");
    throw new Error(
      `@capacitor/core ${core.major} (${
        core.source === "installed" ? "installed" : "from package.json"
      }) does not match Capacitor ${wanted}, which ${
        mismatched.join(", ")
      } targets. Upgrade Capacitor, or install a matching plugin version by hand.`,
    );
  }
  const { manager, lockfile } = await detectPackageManager(root);
  const caps = names.map((n) => table[n]);
  return {
    root,
    capabilities: names,
    packageManager: manager,
    lockfile,
    capacitorMajor: core.major,
    capacitorSource: core.source,
    install: addCommand(manager, caps.map((c) => `${c.npm}@${c.version}`), root),
    sync: { cmd: "npx", args: ["cap", "sync"], cwd: root },
    plist: caps.flatMap((c) =>
      Object.entries(c.iosPlist ?? {}).map(([key, value]) => ({ key, value }))
    ),
    permissions: [...new Set(caps.flatMap((c) => c.androidPermissions ?? []))],
    notes: names.flatMap((n) => table[n].notes ? [`${n}: ${table[n].notes}`] : []),
  };
}

/** One command as a shell-like line. */
function commandLine(command: PlannedCommand): string {
  return [command.cmd, ...command.args].join(" ");
}

/**
 * The plan as the lines `denext mobile add --dry-run` prints.
 *
 * @param plan A plan from {@linkcode planMobileCapabilities}.
 * @returns The lines, without a trailing newline.
 */
export function formatCapabilityPlan(plan: CapabilityPlan): string {
  const lines = [
    `  project        ${plan.root}`,
    `  capacitor      @capacitor/core ${plan.capacitorMajor} (${plan.capacitorSource})`,
    `  package mgr    ${plan.packageManager}${
      plan.lockfile ? ` (${plan.lockfile})` : " (no lockfile)"
    }`,
    `  install        ${commandLine(plan.install)}`,
    ...plan.plist.map((p) => `  Info.plist     ${p.key} (when absent)`),
    ...plan.permissions.map((p) => `  manifest       <uses-permission ${p}>`),
    `  sync           ${commandLine(plan.sync)}`,
  ];
  if (plan.notes.length > 0) {
    lines.push("", "  Then call from denext/mobile:", ...plan.notes.map((n) => `    - ${n}`));
  }
  return lines.join("\n");
}

/**
 * The capability table as the lines `denext mobile add --list` prints.
 *
 * @param table The table (default {@linkcode MOBILE_CAPABILITIES}).
 * @returns One line per capability: its name, package and range, and what it enables.
 */
export function formatCapabilityTable(
  table: Readonly<Record<string, MobileCapability>> = MOBILE_CAPABILITIES,
): string {
  return Object.entries(table).map(([name, c]) =>
    `  ${name.padEnd(14)}${`${c.npm}@${c.version}`.padEnd(46)}${c.notes ?? ""}`
  ).join("\n");
}

/** Apply `edit` to the file at `rel` under `root`, recording the outcome in `report`. */
async function editNative(
  report: AddCapabilitiesReport,
  rel: string,
  platform: string,
  edit: (text: string) => string | null,
): Promise<void> {
  const path = join(report.plan.root, rel);
  const text = await readText(path);
  if (text === undefined) {
    report.skipped.push(
      `${platform}: no ${rel} (run \`cap add ${platform.toLowerCase()}\` first).`,
    );
    return;
  }
  const next = edit(text);
  if (next === null) {
    report.skipped.push(`${rel}: could not find where to add the entries; add them by hand.`);
    return;
  }
  if (next === text) return void report.unchanged.push(rel);
  await Deno.writeTextFile(path, next);
  report.written.push(rel);
}

/** Apply every edit in turn; null as soon as one has no place to go. */
function chain<T>(text: string, items: readonly T[], edit: (t: string, item: T) => string | null) {
  let out: string | null = text;
  for (const item of items) {
    if (out === null) return null;
    out = edit(out, item);
  }
  return out;
}

/** Run `command`, throwing when it exits non-zero. */
async function runChecked(
  run: CommandRunner,
  command: PlannedCommand,
  ran: string[],
): Promise<void> {
  const line = commandLine(command);
  ran.push(line);
  const { code } = await run(command);
  if (code !== 0) throw new Error(`\`${line}\` exited with code ${code}.`);
}

/**
 * Install capabilities into a Capacitor project: plan (see
 * {@linkcode planMobileCapabilities}), then add the packages, write the Info.plist keys and
 * Android permissions, and run `npx cap sync`. With `dryRun` it only plans.
 *
 * @param opts The capability names, where to look, and the command runner.
 * @returns The plan, the native files changed, and the commands run.
 */
export async function addMobileCapabilities(
  opts: AddCapabilitiesOptions,
): Promise<AddCapabilitiesReport> {
  const plan = await planMobileCapabilities(opts);
  const report: AddCapabilitiesReport = {
    plan,
    written: [],
    unchanged: [],
    skipped: [],
    ran: [],
  };
  if (opts.dryRun) return report;
  if (!opts.run) throw new Error("addMobileCapabilities: a command runner is required.");
  await runChecked(opts.run, plan.install, report.ran);
  if (plan.plist.length > 0) {
    await editNative(
      report,
      INFO_PLIST,
      "iOS",
      (t) => chain(t, plan.plist, (text, p) => withPlistDefault(text, p.key, p.value)),
    );
  }
  if (plan.permissions.length > 0) {
    await editNative(
      report,
      ANDROID_MANIFEST,
      "Android",
      (t) => chain(t, plan.permissions, withManifestPermission),
    );
  }
  await runChecked(opts.run, plan.sync, report.ran);
  return report;
}
