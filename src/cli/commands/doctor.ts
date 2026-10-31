// `info` (environment + project facts) and `doctor` (actionable diagnostics that
// supersede the old `probe` verb). `doctor` runs a series of checks — Deno version,
// app dir, config load, and in-process route conformance — printing a pass/fail
// line each and exiting non-zero when a critical check fails (the CI gate `probe`
// used to be, now with environment context around it). `doctor --report` folds the
// same data — plus every route's conformance result and the last build's client
// chunks — into one markdown (or, with `--json`, structured) health report.

import { platformFilesReport } from "../../build/platform-extensions.ts";
import type { DenextConfig } from "../../server/config.ts";
import { join, resolve } from "@std/path";
import { currentDenoIdentity, denoVersionOk, MIN_DENO_VERSION } from "../../build/deno-version.ts";
import { crashReportCheck } from "../../build/crash-report.ts";
import { VERSION } from "../../../mod.ts";
import type { CommandContext, CommandLocks, CommandSpec } from "../command.ts";
import { commandCwd, denoGlobalArgs, projectDir } from "../shared.ts";
import { runDenoPassthrough } from "./deno-toolchain.ts";
import { type ProjectPaths, resolveProject } from "../../build/paths.ts";
import { setupAppPlugins } from "../../plugin/mod.ts";
import { defaultLoader } from "../../server/default-loader.ts";
import { type ConformanceReport, probeApp } from "../../testing/conformance.ts";
import {
  type BundleChunk,
  bundleReportMarkdown,
  readClientChunks,
} from "../../build/bundle-report.ts";
import { checkPrivacyManifest } from "../../build/mobile-privacy.ts";
import { MOBILE_CAPABILITIES } from "../../build/mobile-capabilities.ts";
import { capacitorConfigFile } from "../../build/capacitor-config.ts";
import { leakedCssShimKeys } from "../../build/css-config-guard.ts";
import {
  DESKTOP_APP_CONFIG_FILE,
  desktopAppIdentity,
  desktopBridgeOrigins,
} from "../../build/desktop-app-config.ts";
import {
  desktopPasskeyRpIds,
  isDesktopProject,
  launchPolicyProblems,
  readProjectDenoJson as readDenoJson,
  stalePackageScripts,
  strictLaunchRuntime,
} from "../../build/desktop-launch-policy.ts";
import { DENEXT_EXCLUDE, denextExemptions } from "../../build/dep-age.ts";
import { desktopRuntimeStatus } from "../../build/desktop-runtime.ts";
import {
  DENO_TOOLCHAIN,
  denoToolchainStatus,
  type ToolchainSelection,
  toolchainSelection,
} from "../../build/deno-toolchain.ts";
import { revocationStatusLine } from "../../build/runtime-revocations.ts";
import {
  type LinuxLibc,
  linuxLibcProblem,
  minGlibcFor,
  probeLinuxLibc,
  supportedLinux,
} from "../../build/linux-libc.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { loadNativeDirs } from "../../build/capacitor-native-dirs.ts";
import { backendChecks } from "./doctor-backend.ts";
import { authChecks } from "./doctor-auth.ts";
import {
  signingReadiness,
  type SigningReadinessDeps,
  signingReadinessLines,
  signingReady,
} from "../../build/code-signing.ts";
import { hasCommand, listSigningIdentities } from "../../ui/signing.ts";
import { workspaceRootHint } from "../../build/workspace-imports.ts";
import {
  explainJailFailures,
  grantsSomething,
  homeName,
  JAIL_DEFAULT_RELEASE,
  JAIL_DOCS_URL,
  type JailConfinement,
  jailConfinement,
  jailEffective,
  jailFailures,
  type JailHome,
  jailHostListsSupported,
  jailPatch,
  type JailProject,
  type JailRequirement,
  jailRuntime,
  jailRuntimeInUse,
  type JailRuntimeSeams,
  type JailSetting,
  jailSnippet,
  type LifecycleJail,
  readJailProject,
  readLifecycleJail,
  requiredJailExceptions,
  upstreamByNameAdvice,
} from "../../build/jail-scripts.ts";

/** Whether `path` is an existing directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/**
 * The project directory `denext info` describes, or null when the invocation is Deno's `info`:
 * no argument (the cwd, or `--cwd`) or one argument naming a directory is denext's; a module,
 * file or URL — or any Deno flag — is Deno's.
 */
async function infoProjectDir(ctx: CommandContext): Promise<string | null> {
  if (ctx.rest.length === 0) return projectDir(ctx);
  if (ctx.rest.length > 1 || ctx.rest[0].startsWith("-")) return null;
  const dir = resolve(commandCwd(ctx), ctx.rest[0]);
  return await isDirectory(dir) ? dir : null;
}

export const infoCommand: CommandSpec = {
  name: "info",
  summary: "Print environment + project facts; with a module, Deno's info",
  passthrough: true,
  usage: "  denext info [dir]              denext, Deno and platform versions + the project's\n" +
    "                                 config, mode and app dir (--json)\n" +
    "  denext info <module|file|URL>  Deno's `deno info` for that module (its flags pass through)\n" +
    "Deno's cache locations (`deno info` with no argument): `denext deno info`.",
  positionals: [{ name: "target", help: "Project directory (default: .), or a module for Deno" }],
  run: async (ctx) => {
    const dir = await infoProjectDir(ctx);
    if (dir === null) {
      return await runDenoPassthrough(
        ["info", ...denoGlobalArgs(ctx, { json: true }), ...ctx.rest],
        commandCwd(ctx),
        true,
      );
    }
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
    console.log("  Deno's cache info: denext deno info\n");
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

/**
 * The names of the configured plugins that serve the app's pages from a route tree of their own
 * (they call `ctx.servesRoutes()` — the Pages Router, TanStack Start and React Router plugins), so
 * the app needs no `app/`. A plugin that only adds endpoints (an API, OpenAPI docs, auth, storage)
 * does not count, whatever handlers it registers. The plugins are set up in a registry of their own
 * (as the route probe does), then torn down. Empty when none declares it, or when setup fails.
 */
async function routingPlugins(paths: ProjectPaths): Promise<readonly string[]> {
  const config = paths.config;
  if (!config?.plugins?.length) return [];
  try {
    const set = await setupAppPlugins({
      projectRoot: paths.projectDir,
      appDir: paths.appDir,
      config,
      mode: "dev",
      load: defaultLoader,
    });
    await set.teardown();
    return set.routeServers;
  } catch {
    return [];
  }
}

/**
 * The app-directory check, satisfied without `app/` when a plugin serves the routes (the Pages
 * Router and TanStack Start plugins route from their own trees).
 */
async function appOrPluginRoutesCheck(
  paths: ProjectPaths,
): Promise<{ check: Check; hasAppDir: boolean }> {
  const check = await appDirCheck(paths.appDir);
  if (check.ok) return { check, hasAppDir: true };
  const routing = await routingPlugins(paths);
  if (routing.length === 0) {
    // A monorepo's root: say which members are the apps to run it on.
    const hint = await workspaceRootHint(paths.projectDir);
    return { check: hint ? { ...check, detail: hint } : check, hasAppDir: false };
  }
  const detail = `not needed: routes come from ${routing.join(", ")}`;
  return { check: { ...check, ok: true, detail }, hasAppDir: false };
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
 * The iOS privacy manifest check, for a project that is also a Capacitor project with `ios/`
 * (advisory: `denext mobile privacy` has the details, `denext mobile doctor --store` gates it).
 * Null for any other project.
 */
async function privacyManifestCheck(dir: string): Promise<Check | null> {
  try {
    if (
      !(await capacitorConfigFile(dir)) ||
      !(await Deno.stat(join(dir, (await loadNativeDirs(dir)).ios))).isDirectory
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const { file, findings } = await checkPrivacyManifest(dir, MOBILE_CAPABILITIES);
  const errors = findings.filter((f) => f.level === "error");
  return {
    name: "iOS privacy manifest",
    ok: errors.length === 0,
    detail: errors.length === 0
      ? `${file}: ${findings.length === 0 ? "valid" : `${findings.length} warning(s)`}`
      : `${errors[0].message} (${errors.length} error(s); \`denext mobile privacy\`)`,
    critical: false,
  };
}

/**
 * The leaked css→shim import-map check: absolute `file:` css redirects an interrupted build
 * or dev run left in the committed `deno.json`. They only resolve on the machine that wrote
 * them, so a committed copy breaks every other checkout. Null when the config is clean.
 */
export async function cssShimLeakCheck(configPath: string, outDir: string): Promise<Check | null> {
  const keys = await leakedCssShimKeys(configPath, outDir);
  if (keys.length === 0) return null;
  return {
    name: "css-shim imports",
    ok: false,
    detail:
      `${configPath} has ${keys.length} leaked css-shim import entr${
        keys.length === 1 ? "y" : "ies"
      } (${keys[0]}${keys.length > 1 ? ", …" : ""}); fix: run \`denext build\` or ` +
      "`denext dev` once (it removes them), or delete those `imports` entries by hand",
    critical: true,
  };
}

/**
 * The platform-files check: modules (`BigButton.ios.tsx`, …) that some target's export cannot
 * resolve, per target. Not critical — a module no route imports for that target is fine — but
 * that target's build fails on the first one it reaches. Null when the app has none.
 */
export async function platformFilesCheck(
  projectDir: string,
  config: DenextConfig | null | undefined,
): Promise<Check | null> {
  const report = await platformFilesReport(projectDir, config);
  return report ? { name: "platform files", ...report, critical: false } : null;
}

/**
 * The dependency-age exemption check: a `deno.json` whose `minimumDependencyAge.exclude` lists a
 * `@denext` entry lets a just-published `@denext` release in before Deno's hold has passed.
 * `"jsr:@denext/*"` is what `create` / `migrate` wrote before 4.5.2 (`denext upgrade` removes
 * it); any other (`"jsr:@denext/denext"`, …) denext never writes, so it is the user's to remove.
 * Null without one.
 */
export async function depAgeExemptionCheck(dir: string): Promise<Check | null> {
  const entries = denextExemptions((await readDenoJson(dir))?.minimumDependencyAge);
  if (!entries.length) return null;
  const others = entries.filter((e) => e !== DENEXT_EXCLUDE);
  const fixes = [
    ...entries.includes(DENEXT_EXCLUDE)
      ? [`\`denext upgrade\` removes "${DENEXT_EXCLUDE}" and pins versions old enough`]
      : [],
    ...others.length
      ? [
        `remove ${others.map((e) => `"${e}"`).join(", ")} from minimumDependencyAge.exclude ` +
        "yourself (denext never writes it)",
      ]
      : [],
  ];
  return {
    name: "dependency age",
    ok: false,
    detail:
      `deno.json exempts ${
        entries.map((e) => `"${e}"`).join(", ")
      } from Deno's minimum dependency age, so a just-published @denext release resolves before ` +
      `the hold has passed; fix: ${fixes.join("; ")} (keep an entry only if you publish denext ` +
      "yourself)",
    critical: false,
  };
}

/** The process environment, never throwing (no `--allow-env`). */
function safeEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Options for {@linkcode jailScriptsCheck}. */
export interface JailScriptsCheckOptions {
  /** The runtime version the project installs with (default: the toolchain pin's). */
  readonly version?: string | null;
  /** The environment (default: the process's). */
  readonly env?: (name: string) => string | undefined;
  /** A captured install log (`denext doctor --install-log <file>`) to explain. */
  readonly installLog?: string;
  /** The OS the project installs on (default: this one). */
  readonly os?: typeof Deno.build.os;
  /** How the runtime in use is found when no `version` is given (tests). */
  readonly runtime?: JailRuntimeSeams;
  /**
   * The machine's `lifecycleJail` report (`deno info --json`, runtime 3.0.0-denext.1 and later);
   * default: read from the project's `deno` when the runtime reports it.
   */
  readonly lifecycleJail?: LifecycleJail | null;
}

/** What the jail can't do on Windows, said with every Windows jail detail. */
const WINDOWS_JAIL_NOTE = "on Windows the OS can't confine the scripts' other programs " +
  "(`curl`, a compiler, a downloaded binary): only the scrubbed environment, the scratch HOME " +
  "and every `deno` they start are jailed";

/** Whether the settings (deno.json, or package.json's `"deno"`) approve any lifecycle script. */
function approvesScripts(denoJson: Record<string, unknown> | null): boolean {
  const v = denoJson?.allowScripts;
  if (v === true) return true;
  if (Array.isArray(v)) return v.length > 0;
  const allow = (v as { allow?: unknown } | null | undefined)?.allow;
  return v !== null && typeof v === "object" &&
    (allow === true || Array.isArray(allow) && allow.length > 0);
}

/**
 * The lifecycle-script jail check: dependencies in denext's built-in list
 * (src/build/jail-exceptions.ts) that need a `supplyChain.jailScripts.packages` exception while
 * the jail is on for the project and have none, and, given an install log, the dependencies'
 * scripts it shows failing in the jail (with `supplyChain.jailScripts.upstreamByName` suggested
 * when a listed host failed through a proxy that may take only host names). Advisory. Null when the project has none of those
 * dependencies and the log (if any) shows no jail failure.
 *
 * @param dir The project directory.
 * @param options The runtime version, environment and install log.
 * @returns The check, or null.
 */
export async function jailScriptsCheck(
  dir: string,
  options: JailScriptsCheckOptions = {},
): Promise<Check | null> {
  const name = "lifecycle-script jail";
  const os = options.os ?? Deno.build.os;
  const facts = await jailCheckFacts(dir, options, os);
  const { project, version, explained, required, blocked, on, confinement } = facts;
  const nothing = required.length === 0 && explained.length === 0 && blocked.length === 0;
  if (nothing && !confinement) return null;
  const missing = required.filter((r) => jailPatch(r, project.setting, version) !== null);
  const note = confinementNote(confinement, on, os);
  const lead = jailDetailLead(facts);
  if (on && missing.length) {
    const why = missingJailDetail(missing, project.setting, version, project.home);
    return { name, ok: false, detail: lead + why + note, critical: false };
  }
  const narrow = on ? narrowableJailExceptions(required, project.setting) : [];
  if (explained.length || blocked.length || narrow.length) {
    const body = narrow.map((n) => `${n}; `).join("") + JAIL_DOCS_URL;
    return { name, ok: false, detail: lead + body, critical: false };
  }
  // where the OS can't confine, a project that approves scripts runs them nearly unconfined
  const exposed = confinement?.state === "no-os-sandbox" && approvesScripts(project.settings);
  const detail = nothing
    ? confinement!.detail // the jail's real state on this machine (runtime 3.0.0-denext.1 and later)
    : passingJailDetail(required, project.setting, on) + note;
  return { name, ok: !exposed, detail: lead + detail, critical: false };
}

/** What {@linkcode jailScriptsCheck} decides from. */
interface JailCheckFacts {
  readonly project: JailProject;
  /** The runtime version the installs run on (`null`: a Deno with no jail). */
  readonly version: string | null | undefined;
  /** Said first: the runtime the installs run on, when it is not the pin. */
  readonly notes: readonly string[];
  /** The install log's jail failures and proxy advice, explained. */
  readonly explained: readonly string[];
  /** The listed dependencies that need an exception. */
  readonly required: readonly JailRequirement[];
  /** What stops the settings from doing what they look like they do. */
  readonly blocked: readonly string[];
  /** Whether the jail is on for the project. */
  readonly on: boolean;
  /** The jail's real state on this machine, when the runtime reports it. */
  readonly confinement: { readonly state: JailConfinement; readonly detail: string } | null;
}

/** The text a jail check's detail opens with: the runtime, the blockers, the install log's advice. */
function jailDetailLead(f: JailCheckFacts): string {
  const notes = [...f.notes, ...f.blocked].map((b) => `${b}; `).join("");
  return f.explained.length
    ? `${notes}the install log shows: ${f.explained.map((l) => l.trim()).join(" · ")}; `
    : notes;
}

/** Read the project, the install log and the machine's confinement for the jail check. */
async function jailCheckFacts(
  dir: string,
  options: JailScriptsCheckOptions,
  os: typeof Deno.build.os,
): Promise<JailCheckFacts> {
  // The runtime the installs run on, not the pin, unless the caller names one.
  const runtime = options.version !== undefined ? null : await jailRuntimeInUse(options.runtime);
  const version = runtime ? runtime.version : options.version;
  const log = options.installLog ?? "";
  const project = await readJailProject(dir, {
    ...(options.env ? { env: options.env } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  const { home } = project;
  const explained = [
    ...explainJailFailures(jailFailures(log, os), version, project.setting.packages, home),
    ...upstreamByNameAdvice({
      output: log,
      denoJson: project.settings,
      home,
      env: options.env ?? safeEnv,
      version,
    }),
  ];
  const required = (await requiredJailExceptions(project, undefined, version))
    .filter(grantsSomething);
  const on = jailEffective(project.setting, version);
  const confinement = await confinementOf(dir, project, on, version, options);
  return {
    project,
    version,
    notes: runtime?.overridden ? [`installs run on ${runtime.label}`] : [],
    explained,
    required,
    blocked: jailBlockers(project, os),
    on,
    confinement,
  };
}

/**
 * The configured exceptions that grant a built-in entry's package the whole network (`"net":
 * true`, all a runtime before host lists could take) where this runtime takes its host list:
 * each with the narrower exception to put in its place, the project's own `env` / `write` kept.
 */
function narrowableJailExceptions(
  required: readonly JailRequirement[],
  setting: JailSetting,
): string[] {
  return required.flatMap((r) => {
    const own = Object.hasOwn(setting.packages, r.entry.name)
      ? setting.packages[r.entry.name]
      : undefined;
    if (own?.net !== true || !Array.isArray(r.exception.net)) return [];
    const union = (a?: readonly string[], b?: readonly string[]) => [
      ...new Set([...a ?? [], ...b ?? []]),
    ];
    const env = union(own.env, r.exception.env);
    const write = union(own.write, r.exception.write);
    const narrower = {
      ...own,
      ...(env.length ? { env } : {}),
      ...(write.length ? { write } : {}),
      net: r.exception.net,
    };
    return [
      `${r.entry.name}'s exception grants the whole network ("net": true); this runtime takes ` +
      `the hosts its install script needs: narrow it to ${
        JSON.stringify({ [r.entry.name]: narrower })
      } under "supplyChain.jailScripts.packages"`,
    ];
  });
}

/**
 * What the jail can't confine, said after the check's detail: the runtime's own report where it
 * has one (nothing for a jail that is off), else the static Windows note.
 */
function confinementNote(
  confinement: JailCheckFacts["confinement"],
  on: boolean,
  os: typeof Deno.build.os,
): string {
  if (confinement) return confinement.state === "off" ? "" : ` (${confinement.detail})`;
  return on && os === "windows" ? ` (${WINDOWS_JAIL_NOTE})` : "";
}

/**
 * The jail's real state for the project on this machine: off (the project opted out), or what
 * the runtime's own `lifecycleJail` report says. Null on runtimes before 3.0.0-denext.1 and stock
 * Deno, which don't report it, and when the report can't be had.
 */
async function confinementOf(
  dir: string,
  project: JailProject,
  on: boolean,
  version: string | null | undefined,
  options: JailScriptsCheckOptions,
): Promise<{ readonly state: JailConfinement; readonly detail: string } | null> {
  if (!jailRuntime(version).confinementInfo) return null;
  if (!on) {
    return {
      state: "off",
      detail: `off (${project.setting.source}): dependencies' install scripts run unconfined`,
    };
  }
  const report = options.lifecycleJail !== undefined
    ? options.lifecycleJail
    : await readLifecycleJail(denoExecutable(), dir);
  return report ? jailConfinement(report) : null;
}

/**
 * What stops the project's jail settings from doing what they look like they do: a workspace
 * member's own `supplyChain` (the runtime reads the root's alone), and `paranoid` on Windows,
 * where it refuses every approved install script because the OS can't confine it.
 */
function jailBlockers(project: JailProject, os: typeof Deno.build.os): string[] {
  const out: string[] = [];
  if (project.ignoredPackageJsonSettings) {
    out.push(
      `${project.ignoredPackageJsonSettings}'s "deno" object sets "allowScripts" or ` +
        `"supplyChain", which Deno ignores beside a deno.json (the deno.json is the only home ` +
        `then); fix: move them to ${project.configPath}`,
    );
  }
  if (project.ignoredMemberConfig) {
    out.push(
      `${project.ignoredMemberConfig} sets "supplyChain", which Deno ignores in a workspace ` +
        `member (it reads the root's alone); fix: move it to ${
          project.configPath ?? "the workspace root's deno.json"
        }`,
    );
  }
  if (os === "windows" && project.setting.paranoid && approvesScripts(project.settings)) {
    out.push(
      `${project.setting.paranoid} turns on paranoid, which refuses to run an approved ` +
        "dependency's install script on Windows (the OS can't confine it), so the approved " +
        "scripts in allowScripts don't run; install on Linux or macOS (WSL included), or keep " +
        "paranoid off on this machine",
    );
  }
  return out;
}

/** The jail check's detail for exceptions missing while the jail is on: why, and the fix. */
function missingJailDetail(
  missing: readonly JailRequirement[],
  setting: JailSetting,
  version: string | null | undefined,
  home: JailHome,
): string {
  const why = setting.state === "on"
    ? `${setting.source} turns it on`
    : `on by default from runtime ${JAIL_DEFAULT_RELEASE}`;
  const verb = missing.length === 1 ? "needs" : "need";
  return `${missing.map((r) => r.entry.name).join(", ")} ${verb} an exception: dependencies' ` +
    `install scripts run jailed (${why}) and theirs download or write outside node_modules; ` +
    `fix: add ${JSON.stringify(JSON.parse(jailSnippet(missing, home)))} to ${homeName(home)} ` +
    "(never turn the " +
    `jail off for it): ${JAIL_DOCS_URL}` + cacheNote(missing, version);
}

/** How to keep a browser download that the exception's `~` cache directory grants. */
function cacheNote(missing: readonly JailRequirement[], version?: string | null): string {
  if (!jailHostListsSupported(version)) return "";
  const caches = missing.flatMap((r) => r.entry.cache ? [r.entry.cache] : []);
  return caches.length
    ? `; set ${
      caches.map((c) => `${c.env}=${c.path.replace(/^~/, "$HOME")}`).join(", ")
    } for the install and the app, or the download is lost with the jail's scratch HOME`
    : "";
}

/** The jail check's detail when nothing is missing: off, configured, or needed once it is on. */
function passingJailDetail(
  required: readonly JailRequirement[],
  setting: JailSetting,
  on: boolean,
): string {
  const list = required.map((r) => r.entry.name).join(", ");
  if (setting.state === "off") {
    return `off (${setting.source}); ${list} run${required.length === 1 ? "s" : ""} unconfined`;
  }
  return on
    ? `exceptions configured for ${list}`
    : `${list} will need an exception once dependencies' install scripts run jailed (on by ` +
      `default from runtime ${JAIL_DEFAULT_RELEASE}): ${JAIL_DOCS_URL}`;
}

/**
 * What is out of line for a configured `desktop.app.origin`: the embedded `.deno-desktop/app.json`
 * (missing or stale), deno.json's `compile.include` (not listing it), and deno.json's own
 * `desktop.app.identifier` (different from the config's). Empty when all is in line.
 */
async function desktopOriginProblems(
  dir: string,
  identity: { origin: string; identifier: string },
): Promise<string[]> {
  const problems: string[] = [];
  const appJson = await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE)).catch(() => null);
  let embedded: { origin?: unknown; identifier?: unknown } | null = null;
  try {
    embedded = appJson === null ? null : JSON.parse(appJson);
  } catch { /* unparseable: reported as stale below */ }
  if (embedded?.origin !== identity.origin || embedded?.identifier !== identity.identifier) {
    problems.push(`${DESKTOP_APP_CONFIG_FILE} is ${appJson === null ? "missing" : "stale"}`);
  }
  const deno = await readDenoJson(dir);
  const include = (deno?.compile as { include?: unknown } | undefined)?.include;
  const listed = Array.isArray(include) &&
    include.some((e) =>
      typeof e === "string" && e.replace(/^\.\//, "") === DESKTOP_APP_CONFIG_FILE
    );
  if (!listed) problems.push(`deno.json compile.include does not list ${DESKTOP_APP_CONFIG_FILE}`);
  const denoId = ((deno?.desktop as { app?: { identifier?: unknown } } | undefined)?.app)
    ?.identifier;
  if (denoId !== undefined && denoId !== identity.identifier) {
    problems.push(`deno.json desktop.app.identifier "${denoId}" differs from the config's`);
  }
  return problems;
}

/**
 * The desktop app-origin check, for a project that sets `desktop.app.origin` (advisory; null
 * otherwise). The origin and identifier themselves are validated at config load; this checks the
 * files the packager derives from them, which `denext desktop package` / `run` rewrite.
 */
export async function desktopOriginCheck(dir: string, config: unknown): Promise<Check | null> {
  let identity;
  try {
    identity = desktopAppIdentity(config);
  } catch (err) {
    return {
      name: "desktop app origin",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      critical: false,
    };
  }
  if (!identity) return null;
  const problems = await desktopOriginProblems(dir, identity);
  return {
    name: "desktop app origin",
    ok: problems.length === 0,
    detail: problems.length === 0
      ? `${identity.origin} (${identity.identifier}); needs the denext-pinned Deno Desktop runtime`
      : `${
        problems.join("; ")
      } — run \`denext desktop package\` or \`denext desktop run\` to rewrite`,
    critical: false,
  };
}

/**
 * The packaged launch-policy check, for a desktop project (null otherwise): whether the
 * `laufey-launch.json` the package scripts write would pin the window's bridge (`bridgeOrigins`)
 * and, with passkeys enabled, their relying parties (`passkeyRpIds`), which the strict launch
 * policy (runtime 3.0.0-denext.1+) otherwise fails closed on; and whether the scripts write it at
 * all. Advisory.
 *
 * @param dir The project directory.
 * @param config The loaded project config.
 * @returns The check, or `null` for a project without a desktop target.
 */
export async function desktopLaunchPolicyCheck(
  dir: string,
  config: unknown,
): Promise<Check | null> {
  if (!await isDesktopProject(dir)) return null;
  const problems = launchPolicyProblems(
    config,
    desktopBridgeOrigins,
    await stalePackageScripts(dir),
  );
  const pinned = desktopPasskeyRpIds(config) === null
    ? "bridgeOrigins"
    : "bridgeOrigins + passkeyRpIds";
  return {
    name: "desktop launch policy",
    ok: problems.length === 0,
    detail: problems.length === 0
      ? `${pinned} pinned${strictLaunchRuntime() ? " (strictPolicy: the rest fails closed)" : ""}`
      : problems.map((p) => `${p.message} — ${p.fix}`).join("; "),
    critical: false,
  };
}

/** The desktop checks that apply to the project: the app origin, the runtime, the launch policy. */
async function desktopChecks(dir: string, config: unknown): Promise<Check[]> {
  const checks = [
    await desktopOriginCheck(dir, config),
    await desktopRuntimeCheck(dir),
    await desktopLaunchPolicyCheck(dir, config),
  ];
  return checks.filter((c): c is Check => c !== null);
}

/**
 * The pinned Deno Desktop runtime check, for a desktop project (a `desktop.ts` entry or a deno.json
 * `desktop` block; null otherwise): the pinned runtime version, whether it is cached and verified
 * for this host, and whether the `deno` that runs `deno desktop` is its exact Deno version.
 * Advisory: a missing cache is fine (it downloads on first use). Never downloads.
 */
export async function desktopRuntimeCheck(
  dir: string,
  options: Partial<Parameters<typeof desktopRuntimeStatus>[0]> = {},
): Promise<Check | null> {
  if (!await isDesktopProject(dir)) return null;
  const status = await desktopRuntimeStatus({
    projectDir: dir,
    deno: denoExecutable(),
    ...options,
  });
  return { name: "desktop runtime", ok: status.ok, detail: status.detail, critical: false };
}

/**
 * The compiled binary's signing readiness, when `compile.sign` is configured (null otherwise):
 * the macOS identity (and whether the keychain holds it), the notary credentials, the Windows
 * certificate and the Authenticode tools. Advisory — `compile.sign` without credentials only
 * warns at build time. Reads no secret.
 */
export async function compileSigningCheck(
  config: DenextConfig | null | undefined,
  deps: Partial<SigningReadinessDeps> = {},
): Promise<Check | null> {
  const sign = config?.compile?.sign;
  if (sign === undefined || sign === false) return null;
  const readiness = await signingReadiness({
    has: (cmd) => hasCommand(cmd),
    identities: () => listSigningIdentities(),
    ...deps,
  });
  return {
    name: "compile signing",
    ok: signingReady(readiness, deps.os),
    detail: signingReadinessLines(readiness).join("; "),
    critical: false,
  };
}

/** A task command that runs `deno test` itself (stock Deno under `deno task`). */
const STOCK_DENO_TEST = /(?:^|[;&|(]\s*)deno\s+test\b/;

/** The deno.json tasks that call `deno test` directly. */
async function stockDenoTestTasks(dir: string): Promise<string[]> {
  const tasks = (await readDenoJson(dir))?.tasks;
  if (typeof tasks !== "object" || tasks === null) return [];
  return Object.entries(tasks as Record<string, unknown>)
    .filter(([, v]) => {
      const command = typeof v === "string" ? v : (v as { command?: unknown })?.command;
      return typeof command === "string" && STOCK_DENO_TEST.test(command);
    })
    .map(([name]) => name);
}

/**
 * denext's Deno toolchain: the pinned version, whether it is cached and verified, and whether
 * this run is on it (or stock Deno, and why). When the toolchain is in use, it also names the
 * deno.json tasks that call `deno test` themselves — `deno task` runs those on the Deno that
 * started it, stock Deno, so they miss the toolchain's Vitest/Jest compat and `Deno.SQL`.
 * Advisory; never downloads.
 *
 * @param dir The project directory.
 * @param options Seams for {@linkcode denoToolchainStatus}.
 * @returns The check.
 */
export async function denoToolchainCheck(
  dir: string,
  options: Parameters<typeof denoToolchainStatus>[0] = {},
): Promise<Check> {
  let status;
  try {
    status = await denoToolchainStatus(options);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { name: "deno toolchain", ok: false, detail, critical: false };
  }
  const tasks = status.mode === "stock" || status.state === "unpinned" ||
      status.state === "unsupported"
    ? []
    : await stockDenoTestTasks(dir);
  const note = tasks.length === 0 ? "" : `; deno.json task${tasks.length > 1 ? "s" : ""} ` +
    `${tasks.map((t) => `"${t}"`).join(", ")} run${tasks.length > 1 ? "" : "s"} \`deno test\` ` +
    "on stock Deno under a plain `deno task` — run it with `denext task`, " +
    "or use `denext test` there";
  return {
    name: "deno toolchain",
    ok: status.ok && tasks.length === 0,
    detail: status.detail + note,
    critical: false,
  };
}

/**
 * The revoked-runtimes list (src/build/runtime-revocations.ts), fetched now: its sequence and
 * expiry, whether the pinned toolchain is revoked for this host and what runs instead. Warns on a
 * revoked pin and on an expired list. `null` while no revocation key is configured in this denext
 * (or `DENEXT_REVOCATION_CHECK=0`): the check is off. Advisory.
 *
 * @param select The selection (test seam; default {@linkcode toolchainSelection} in `force` mode).
 * @returns The check, or `null`.
 */
export async function runtimeRevocationsCheck(
  select: () => Promise<ToolchainSelection> = () => toolchainSelection("force"),
): Promise<Check | null> {
  const selected = await select().catch(() => null);
  const revocation = selected?.revocation;
  if (!revocation?.configured) return null;
  const line = revocationStatusLine(revocation);
  return { name: "runtime revocations", ok: line.ok, detail: line.detail, critical: false };
}

/**
 * On Linux, whether denext's Deno binaries (the toolchain, `denort`, the Deno Desktop runtime) run
 * on this host: glibc at or above the pin's minimum, not musl. `null` off Linux.
 *
 * @param options Test seams: the host OS and the probe's answer.
 * @returns The check, or `null`.
 */
export async function linuxLibcCheck(
  options: { os?: string; libc?: LinuxLibc } = {},
): Promise<Check | null> {
  if ((options.os ?? Deno.build.os) !== "linux") return null;
  const libc = options.libc ?? await probeLinuxLibc();
  const min = minGlibcFor(DENO_TOOLCHAIN);
  const problem = linuxLibcProblem(libc, min);
  const found = libc.kind === "glibc"
    ? `glibc ${libc.version}`
    : libc.kind === "musl"
    ? "musl"
    : "unknown (no getconf / ldd answer)";
  return {
    name: "linux libc",
    ok: problem === null,
    detail: problem === null
      ? `${found} (denext's Deno needs glibc ${min} or later)`
      : `${problem}; supported: ${supportedLinux(min)}`,
    critical: false,
  };
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
export async function collectDoctorReport(
  dir: string,
  options: { installLog?: string } = {},
): Promise<DoctorReport> {
  const checks: Check[] = [
    denoVersionCheck(),
    await denoToolchainCheck(dir),
    ...[
      await runtimeRevocationsCheck(),
      await linuxLibcCheck(),
      crashReportCheck(safeEnv, currentDenoIdentity().denext),
    ].filter((c): c is Check => c !== null),
  ];

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
    const { check, hasAppDir } = await appOrPluginRoutesCheck(paths);
    // The route probe walks `app/`: a plugin-routed app has none to walk.
    appOk = hasAppDir;
    checks.push(check);
  }
  // Reaching here means the config loaded and passed validation → report correctness.
  checks.push({
    name: "config",
    ok: true,
    detail: paths.config ? `loaded & validated: ${paths.configPath}` : "none (using defaults)",
    critical: false,
  });
  const leak = await cssShimLeakCheck(paths.configPath, paths.outDir);
  if (leak) checks.push(leak);
  let routes: ConformanceReport | null = null;
  if (!isSpa && appOk) {
    const r = await routeConformance(dir);
    checks.push(r.check);
    routes = r.report;
  }
  const platformFiles = await platformFilesCheck(paths.projectDir, paths.config);
  if (platformFiles) checks.push(platformFiles);
  const privacy = await privacyManifestCheck(dir);
  if (privacy) checks.push(privacy);
  checks.push(...await desktopChecks(dir, paths.config));
  const signing = await compileSigningCheck(paths.config);
  if (signing) checks.push(signing);
  const depAge = await depAgeExemptionCheck(paths.projectDir);
  if (depAge) checks.push(depAge);
  const jail = await jailScriptsCheck(paths.projectDir, options);
  if (jail) checks.push(jail);
  checks.push(...await backendChecks(paths.projectDir, paths.config), ...authChecks(paths.config));

  return { dir, checks, routes, bundle: await builtClientChunks(paths.outDir) };
}

/** The checks alone (the plain `denext doctor` listing); see {@link collectDoctorReport}. */
async function collectDoctorChecks(
  dir: string,
  options: { installLog?: string } = {},
): Promise<Check[]> {
  return (await collectDoctorReport(dir, options)).checks;
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
    return [
      "_Not probed — SPA mode, a missing app directory, routes served by a plugin, or a config " +
      "failure above._",
    ];
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
async function collectQuietly(
  dir: string,
  options: { installLog?: string },
): Promise<DoctorReport> {
  const origLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await collectDoctorReport(dir, options);
  } finally {
    console.log = origLog;
  }
}

/** `--install-log <file>`'s text (exit 1 when it can't be read). */
async function installLogOption(ctx: CommandContext): Promise<{ installLog?: string }> {
  const file = ctx.flags["install-log"];
  if (typeof file !== "string") return {};
  try {
    return { installLog: await Deno.readTextFile(resolve(commandCwd(ctx), file)) };
  } catch (err) {
    console.error(`denext doctor: can't read --install-log ${file}: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

/**
 * The build-directory lock `doctor` runs under. It reads the last build in `.denext/` (and probes
 * the routes in-process): SHARED, so it runs beside other readers and waits out a build rather
 * than reading it half-done. But a project with plugins has the probe run their prepare steps,
 * which write `.denext/` under the lock EXCLUSIVE — and a held shared lock is never upgraded in
 * place — so for such a project doctor takes it exclusive from the start. So does a config that
 * doesn't load here: doctor loads it again for its checks, and should that load succeed (a config
 * whose failure was transient), its probe runs the plugins' prepare steps under the lock it holds.
 *
 * @param ctx The invocation.
 * @returns The locks.
 */
export async function doctorLocks(ctx: CommandContext): Promise<CommandLocks> {
  const dir = projectDir(ctx);
  return { projectDir: dir, buildDir: await probeWritesBuildDir(dir) ? "exclusive" : "shared" };
}

/**
 * Whether doctor's route probe on `dir` may run plugin prepare steps (which write `.denext/`):
 * true for a project with plugins, and when the config can't be loaded to tell (exclusive is what
 * every later outcome can run under).
 */
async function probeWritesBuildDir(dir: string): Promise<boolean> {
  try {
    const { config } = await resolveProject(dir);
    return config?.mode !== "spa" && (config?.plugins?.length ?? 0) > 0;
  } catch {
    return true;
  }
}

export const doctorCommand: CommandSpec = {
  name: "doctor",
  summary: "Diagnose the project (supersedes probe)",
  aliases: ["probe"],
  loadsModules: true,
  locks: doctorLocks,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  flags: [{
    name: "report",
    type: "boolean",
    help: "Print a markdown health report (checks, every route's conformance, the last " +
      "build's client bundle by chunk); with --json, the same data as JSON",
  }, {
    name: "install-log",
    type: "string",
    valueName: "<file>",
    help: "Explain the dependencies' lifecycle scripts that failed in this captured install " +
      "output (`denext install 2>&1 | tee install.log`) as lifecycle-script jail failures",
  }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const report = ctx.flags.report === true;
    const options = await installLogOption(ctx);
    if (report || ctx.global.json) {
      const r = await collectQuietly(dir, options);
      if (ctx.global.json) console.log(JSON.stringify(report ? r : r.checks, null, 2));
      else console.log(doctorReportMarkdown(r).join("\n"));
      if (hasCriticalFailure(r.checks)) Deno.exit(1);
      return;
    }
    console.log(`\n  denext doctor  ▸  ${dir}\n`);
    reportChecks(await collectDoctorChecks(dir, options));
  },
};
