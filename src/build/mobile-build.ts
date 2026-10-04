// `denext mobile build ios|android`: the web export, `cap sync`, and the native build, as one
// command that ends in a store artifact.
//
//   export   `denext export <app>` (with the flavor's env), unless --skip-export
//   flavor   the flavor's app id / name / server URL (and icons) applied to capacitor.config.* and
//            the native project, restored byte for byte when the build ends
//   sync     `npx cap sync <platform>`
//   ios      xcodebuild archive (Debug, or Release with --release), then -exportArchive with
//            automatic signing (a team, and an App Store Connect API key when one is configured)
//            into a signed .ipa; --unsigned archives with CODE_SIGNING_ALLOWED=NO and zips the
//            .app into an unsigned .ipa (CI, or re-signing elsewhere)
//   android  gradlew assembleDebug (a debug-signed .apk), or with --release bundleRelease (an
//            .aab; --apk: assembleRelease) signed with the upload keystore when one is configured
//
// Secrets never reach denext's own command line or output: the keystore passwords go to Gradle as
// android.injected.signing.* project properties inside GRADLE_OPTS (the environment), and the API
// key stays a path. CAVEAT: the stock `gradlew` script expands GRADLE_OPTS into the wrapper JVM's
// argv, so for the build's duration the passwords are visible to `ps` for processes that can read
// that JVM's command line (same user; root) — use a dedicated build user on a shared CI host.
// The artifact is copied to dist/mobile/<platform>[-<flavor>]/ with a <artifact>.json sidecar
// (app id, version, build number, SHA-256) that `denext mobile submit` reads.

import { basename, join } from "@std/path";
import { toPosixPath } from "./mobile-paths.ts";
import type { MobileFlavorConfig } from "../server/config.ts";
import type { PlannedCommand } from "./mobile-capabilities.ts";
import { checkArtifact } from "./mobile-artifact.ts";
import { capacitorConfigFile, readCapacitorConfig } from "./capacitor-config.ts";
import { isDevServerUrl, mobileDevBackupPresent } from "./mobile-dev.ts";
import {
  androidVersions,
  applyAndroidVersions,
  applyFlavor,
  capacitorIdentity,
  flavorAppId,
  iosVersions,
  type MobilePlatform,
  NATIVE_FILES,
  NativeSnapshot,
  type ResolvedFlavor,
} from "./mobile-flavor.ts";

/** A command a build step runs; `env` carries secrets and is never printed. */
export interface BuildCommand extends PlannedCommand {
  readonly env?: Readonly<Record<string, string>>;
}

/** Runs a {@linkcode BuildCommand}, resolving its exit code. */
export type BuildRunner = (command: BuildCommand) => Promise<{ code: number }>;

/** How the build is signed, as the plan shows it (never a secret). */
export interface SigningPlan {
  /** `debug` (Android debug key), `automatic` (Xcode), `keystore`, or `unsigned`. */
  readonly mode: "debug" | "automatic" | "keystore" | "unsigned";
  /** Where the identity came from, for the listing. */
  readonly detail: string;
}

/** Everything `mobile build` will do, computed without running anything. */
export interface MobileBuildPlan {
  readonly platform: MobilePlatform;
  readonly root: string;
  readonly appDir: string;
  readonly flavor?: ResolvedFlavor;
  readonly configuration: "Debug" | "Release";
  readonly appId: string;
  readonly version?: string;
  readonly buildNumber?: number;
  readonly signing: SigningPlan;
  /** The commands, in order (`export` and `sync` first unless skipped). */
  readonly commands: readonly BuildCommand[];
  /** Where the native build leaves its artifact. */
  readonly produced: string;
  /** The artifact's final path under the output directory. */
  readonly artifact: string;
  /** For --unsigned iOS: the archive whose .app is zipped into the .ipa. */
  readonly archive?: string;
  /** For signed iOS without --export-options: the ExportOptions.plist written before exporting. */
  readonly exportOptions?: { readonly path: string; readonly content: string };
  readonly warnings: readonly string[];
}

/** Options for {@linkcode planMobileBuild}. */
export interface MobileBuildOptions {
  /** The Capacitor project (ios/, android/, capacitor.config.*). */
  readonly root: string;
  /** The denext app `denext export` runs in (often the same folder). */
  readonly appDir: string;
  readonly platform: MobilePlatform;
  readonly release?: boolean;
  readonly flavor?: ResolvedFlavor;
  /** iOS: build without signing (an unsigned .ipa). */
  readonly unsigned?: boolean;
  /** Android --release: an .apk instead of an .aab. */
  readonly apk?: boolean;
  /** A build number for this build only (CFBundleVersion / versionCode). */
  readonly buildNumber?: number;
  /** A version for this build only (CFBundleShortVersionString / versionName). */
  readonly versionName?: string;
  readonly skipExport?: boolean;
  /** Parallel jobs (xcodebuild -jobs, gradle --max-workers). */
  readonly jobs?: number;
  /** iOS export method (`app-store-connect`, `release-testing`, `debugging`, `enterprise`). */
  readonly exportMethod?: string;
  /** An ExportOptions.plist of your own, used verbatim. */
  readonly exportOptions?: string;
  /** Output directory (default: <root>/dist/mobile). */
  readonly outDir?: string;
  /** Signing inputs: flags first, then the environment. */
  readonly signing?: SigningInputs;
  /** The `deno` invocation of the denext CLI (`["run", "-A", "<cli>"]`). */
  readonly cli: readonly string[];
  /** The `deno` executable. */
  readonly deno: string;
  /** The inherited GRADLE_OPTS, kept in front of the signing properties. */
  readonly gradleOpts?: string;
}

/** Signing inputs (paths and ids; passwords only through `env`). */
export interface SigningInputs {
  /** Apple team id. */
  readonly team?: string;
  /** App Store Connect API key (.p8) path, id and issuer, for automatic signing on CI. */
  readonly ascKeyPath?: string;
  readonly ascKeyId?: string;
  readonly ascIssuerId?: string;
  /** Android upload keystore path and key alias. */
  readonly keystore?: string;
  readonly keyAlias?: string;
  /** Keystore / key passwords (from the environment only). */
  readonly keystorePassword?: string;
  readonly keyPassword?: string;
}

/** The environment variables signing reads, by input. */
const SIGNING_ENV = {
  team: ["DENEXT_IOS_TEAM", "APPLE_TEAM_ID"],
  ascKeyPath: ["DENEXT_ASC_KEY_PATH", "ASC_KEY_PATH"],
  ascKeyId: ["DENEXT_ASC_KEY_ID", "ASC_KEY_ID"],
  ascIssuerId: ["DENEXT_ASC_ISSUER_ID", "ASC_ISSUER_ID"],
  keystore: ["DENEXT_ANDROID_KEYSTORE", "ANDROID_KEYSTORE_PATH"],
  keyAlias: ["DENEXT_ANDROID_KEY_ALIAS", "ANDROID_KEY_ALIAS"],
  keystorePassword: ["DENEXT_ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEYSTORE_PASSWORD"],
  keyPassword: ["DENEXT_ANDROID_KEY_PASSWORD", "ANDROID_KEY_PASSWORD"],
} as const;

/**
 * Signing inputs from flags, falling back to the environment variables listed in `SIGNING_ENV`. A key
 * id is also read from an `AuthKey_<ID>.p8` file name.
 */
export function signingInputs(
  flags: Partial<Record<keyof typeof SIGNING_ENV, string>>,
  env: (name: string) => string | undefined,
): SigningInputs {
  const out: Record<string, string> = {};
  for (const [key, names] of Object.entries(SIGNING_ENV)) {
    const value = flags[key as keyof typeof SIGNING_ENV] ??
      names.map((n) => env(n)).find((v) => v !== undefined && v !== "");
    if (value !== undefined) out[key] = value;
  }
  if (!out.ascKeyId && out.ascKeyPath) {
    const id = /AuthKey_([A-Z0-9]+)\.p8$/.exec(basename(out.ascKeyPath))?.[1];
    if (id) out.ascKeyId = id;
  }
  return out;
}

/** A file-system-safe slug of the app name. */
function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "App";
}

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** The Xcode container: a CocoaPods workspace when there is one, else the project. */
async function xcodeContainer(root: string): Promise<string[]> {
  const workspace = join(root, "ios/App/App.xcworkspace");
  return await exists(join(root, "ios/App/Podfile")) && await exists(workspace)
    ? ["-workspace", workspace]
    : ["-project", join(root, "ios/App/App.xcodeproj")];
}

/** The iOS signing the plan uses. */
function iosSigning(opts: MobileBuildOptions): SigningPlan {
  const s = opts.signing ?? {};
  if (opts.unsigned) return { mode: "unsigned", detail: "CODE_SIGNING_ALLOWED=NO (--unsigned)" };
  const key = s.ascKeyPath && s.ascKeyId && s.ascIssuerId
    ? ", App Store Connect API key (-authenticationKeyPath)"
    : "";
  return {
    mode: "automatic",
    detail: s.team
      ? `automatic, team ${s.team}${key}`
      : `automatic, the team set in the Xcode project${key}`,
  };
}

/** The xcodebuild flags that authenticate with an App Store Connect API key, if configured. */
function ascAuthArgs(s: SigningInputs): string[] {
  if (!s.ascKeyPath || !s.ascKeyId || !s.ascIssuerId) return [];
  return [
    "-authenticationKeyPath",
    s.ascKeyPath,
    "-authenticationKeyID",
    s.ascKeyId,
    "-authenticationKeyIssuerID",
    s.ascIssuerId,
  ];
}

/** The iOS export method for the configuration (Xcode 15.3+ names). */
function exportMethod(opts: MobileBuildOptions): string {
  return opts.exportMethod ?? (opts.release ? "app-store-connect" : "debugging");
}

/**
 * An ExportOptions.plist for automatic signing.
 *
 * @param method The export method.
 * @param team The team id, when known.
 */
function exportOptionsPlist(method: string, team?: string): string {
  const teamEntry = team ? `\t<key>teamID</key>\n\t<string>${team}</string>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>${method}</string>
\t<key>destination</key>
\t<string>export</string>
\t<key>signingStyle</key>
\t<string>automatic</string>
${teamEntry}\t<key>manageAppVersionAndBuildNumber</key>
\t<false/>
</dict>
</plist>
`;
}

/** The iOS commands and where the .ipa lands. */
async function iosCommands(
  opts: MobileBuildOptions,
  work: string,
): Promise<
  {
    commands: BuildCommand[];
    produced: string;
    archive: string;
    exportOptions?: { path: string; content: string };
  }
> {
  const s = opts.signing ?? {};
  const configuration = opts.release ? "Release" : "Debug";
  const archive = join(work, "App.xcarchive");
  const settings = [
    ...(opts.buildNumber === undefined ? [] : [`CURRENT_PROJECT_VERSION=${opts.buildNumber}`]),
    ...(opts.versionName === undefined ? [] : [`MARKETING_VERSION=${opts.versionName}`]),
  ];
  const signing = opts.unsigned
    ? ["CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY="]
    : [
      "-allowProvisioningUpdates",
      ...ascAuthArgs(s),
      "CODE_SIGN_STYLE=Automatic",
      ...(s.team ? [`DEVELOPMENT_TEAM=${s.team}`] : []),
    ];
  const archiveCmd: BuildCommand = {
    cmd: "xcodebuild",
    args: [
      "archive",
      ...(await xcodeContainer(opts.root)),
      "-scheme",
      "App",
      "-configuration",
      configuration,
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archive,
      "-derivedDataPath",
      join(work, "DerivedData"),
      ...(opts.jobs ? ["-jobs", String(opts.jobs)] : []),
      ...signing,
      ...settings,
    ],
    cwd: opts.root,
  };
  if (opts.unsigned) return { commands: [archiveCmd], produced: join(work, "App.ipa"), archive };
  const exportPath = join(work, "export");
  const plist = join(work, "ExportOptions.plist");
  const exportCmd: BuildCommand = {
    cmd: "xcodebuild",
    args: [
      "-exportArchive",
      "-archivePath",
      archive,
      "-exportPath",
      exportPath,
      "-exportOptionsPlist",
      opts.exportOptions ?? plist,
      "-allowProvisioningUpdates",
      ...ascAuthArgs(s),
    ],
    cwd: opts.root,
  };
  return {
    commands: [archiveCmd, exportCmd],
    produced: join(exportPath, "App.ipa"),
    archive,
    ...(opts.exportOptions ? {} : {
      exportOptions: { path: plist, content: exportOptionsPlist(exportMethod(opts), s.team) },
    }),
  };
}

/** The Android signing the plan uses, and the Gradle env that carries it. */
function androidSigning(
  opts: MobileBuildOptions,
): { plan: SigningPlan; env: Record<string, string>; warnings: string[] } {
  if (!opts.release) {
    return { plan: { mode: "debug", detail: "the Android debug key" }, env: {}, warnings: [] };
  }
  const s = opts.signing ?? {};
  if (!s.keystore) {
    return {
      plan: { mode: "unsigned", detail: "no keystore (--keystore or DENEXT_ANDROID_KEYSTORE)" },
      env: {},
      warnings: [
        "the release build is unsigned: Google Play needs it signed with your upload key " +
        "(--keystore / DENEXT_ANDROID_KEYSTORE, DENEXT_ANDROID_KEY_ALIAS, " +
        "DENEXT_ANDROID_KEYSTORE_PASSWORD, DENEXT_ANDROID_KEY_PASSWORD)",
      ],
    };
  }
  const missing = [
    ...(s.keyAlias ? [] : ["key alias (--key-alias / DENEXT_ANDROID_KEY_ALIAS)"]),
    ...(s.keystorePassword ? [] : ["keystore password (DENEXT_ANDROID_KEYSTORE_PASSWORD)"]),
  ];
  if (missing.length) {
    throw new Error(`signing with ${s.keystore} needs the ${missing.join(" and the ")}`);
  }
  const values = {
    // `/` on every OS: Gradle takes it on Windows too, and a `\` cannot ride GRADLE_OPTS.
    "store.file": toPosixPath(s.keystore),
    "store.password": s.keystorePassword!,
    "key.alias": s.keyAlias!,
    "key.password": s.keyPassword ?? s.keystorePassword!,
  };
  // GRADLE_OPTS splits on whitespace and treats quotes specially: refuse what it would mangle.
  const bad = Object.entries(values).find(([, v]) => /[\s"'\\$`]/.test(v));
  if (bad) {
    throw new Error(
      `the Android signing ${bad[0]} contains whitespace, a quote, \\, $ or \`, which Gradle's ` +
        "GRADLE_OPTS cannot carry (pass it in android/key.properties + a signingConfig instead)",
    );
  }
  // Project properties as org.gradle.project.* system properties in GRADLE_OPTS: an environment
  // variable, so never in denext's argv or the printed plan — but `gradlew` splices GRADLE_OPTS
  // into the wrapper JVM's argv (see the header caveat). (ORG_GRADLE_PROJECT_* variables do not
  // reach AGP's android.injected.* options.)
  const props = Object.entries(values).map(([k, v]) =>
    `-Dorg.gradle.project.android.injected.signing.${k}=${v}`
  );
  return {
    plan: { mode: "keystore", detail: `upload keystore ${s.keystore}, alias ${s.keyAlias}` },
    env: { GRADLE_OPTS: [opts.gradleOpts ?? "", ...props].join(" ").trim() },
    warnings: [],
  };
}

/** The Gradle task and where its output lands. */
function androidTask(
  opts: MobileBuildOptions,
  signed: boolean,
): { task: string; produced: string } {
  const out = join(opts.root, "android/app/build/outputs");
  if (!opts.release) {
    return { task: "assembleDebug", produced: join(out, "apk/debug/app-debug.apk") };
  }
  if (!opts.apk) {
    return { task: "bundleRelease", produced: join(out, "bundle/release/app-release.aab") };
  }
  return {
    task: "assembleRelease",
    produced: join(out, `apk/release/app-release${signed ? "" : "-unsigned"}.apk`),
  };
}

/** The web export and `cap sync` commands (export skipped with --skip-export). */
function webCommands(
  opts: MobileBuildOptions,
  flavor: MobileFlavorConfig | undefined,
): BuildCommand[] {
  const exportCmd: BuildCommand = {
    cmd: opts.deno,
    args: [...opts.cli, "export", opts.appDir],
    cwd: opts.appDir,
    ...(flavor?.env ? { env: flavor.env } : {}),
  };
  const sync: BuildCommand = { cmd: "npx", args: ["cap", "sync", opts.platform], cwd: opts.root };
  return opts.skipExport ? [sync] : [exportCmd, sync];
}

/** The native half of a plan: the platform's commands, output and signing. */
interface NativePlan {
  commands: BuildCommand[];
  produced: string;
  archive?: string;
  exportOptions?: { path: string; content: string };
  signing: SigningPlan;
  warnings: string[];
}

/**
 * The Gradle wrapper as a command: `./gradlew`, or the `gradlew.bat` Capacitor's Android project
 * ships beside it on Windows (which cannot run the shell script).
 *
 * @param os The host OS.
 */
export function gradlewCommand(os: typeof Deno.build.os = Deno.build.os): string {
  return os === "windows" ? "./gradlew.bat" : "./gradlew";
}

/**
 * Why this host cannot run an iOS `step` (`build` needs xcodebuild, `submit` altool, both only in
 * Xcode on macOS), or undefined on macOS. A `--dry-run` plan and checks still work anywhere.
 *
 * @param step What the caller is about to do.
 * @param os The host OS.
 */
export function iosHostError(
  step: "build" | "submit",
  os: typeof Deno.build.os = Deno.build.os,
): string | undefined {
  if (os === "darwin") return undefined;
  const tool = step === "build" ? "xcodebuild" : "xcrun altool";
  return `the iOS ${step} needs macOS with Xcode (${tool}), and this host is ${os}: run it on a ` +
    `Mac (\`denext mobile ${step} ios --dry-run\` still checks and plans here)`;
}

/** The Android native plan: one Gradle task, signed through the environment. */
function androidNative(opts: MobileBuildOptions): NativePlan {
  const signing = androidSigning(opts);
  const { task, produced } = androidTask(opts, signing.plan.mode === "keystore");
  const env = Object.keys(signing.env).length ? { env: signing.env } : {};
  return {
    commands: [{
      cmd: gradlewCommand(),
      args: [task, ...(opts.jobs ? [`--max-workers=${opts.jobs}`] : [])],
      cwd: join(opts.root, "android"),
      ...env,
    }],
    produced,
    signing: signing.plan,
    warnings: signing.warnings,
  };
}

/** The iOS native plan: archive (+ export unless unsigned). */
async function iosNative(opts: MobileBuildOptions): Promise<NativePlan> {
  const work = join(opts.root, ".denext/mobile-build", "ios");
  return { ...(await iosCommands(opts, work)), signing: iosSigning(opts), warnings: [] };
}

/** The version and build number the project carries. */
async function projectVersions(
  root: string,
  platform: MobilePlatform,
): Promise<{ build?: number; version?: string }> {
  const file = join(root, platform === "ios" ? NATIVE_FILES.pbxproj : NATIVE_FILES.gradle);
  const text = await Deno.readTextFile(file).catch(() => "");
  return platform === "ios" ? iosVersions(text) : androidVersions(text);
}

/** Where the artifact is copied: `<out>/<platform>[-<flavor>]/<App>[-<flavor>]-<config>…`. */
function artifactPath(
  opts: MobileBuildOptions,
  appName: string | undefined,
  signing: SigningPlan,
): string {
  const { platform } = opts;
  const ext = platform === "ios" ? "ipa" : opts.release && !opts.apk ? "aab" : "apk";
  const configuration = opts.release ? "release" : "debug";
  const flavorPart = opts.flavor ? `-${opts.flavor.name}` : "";
  const unsignedPart = signing.mode === "unsigned" ? "-unsigned" : "";
  const outDir = join(opts.outDir ?? join(opts.root, "dist/mobile"), `${platform}${flavorPart}`);
  return join(
    outDir,
    `${slug(appName ?? "App")}${flavorPart}-${configuration}${unsignedPart}.${ext}`,
  );
}

/**
 * Plan a build: the commands, the signing, the artifact. Reads the native project (versions,
 * ids); changes nothing.
 *
 * @param opts What to build.
 * @returns The plan.
 * @throws {Error} When the platform's native project is missing, or signing is half configured.
 */
export async function planMobileBuild(opts: MobileBuildOptions): Promise<MobileBuildPlan> {
  const { platform, root } = opts;
  if (!(await exists(join(root, platform)))) {
    throw new Error(`no ${platform}/ in ${root} (run \`npx cap add ${platform}\` first)`);
  }
  const identity = await capacitorIdentity(root);
  const versions = await projectVersions(root, platform);
  const native = platform === "ios" ? await iosNative(opts) : androidNative(opts);
  const unsigned = native.signing.mode === "unsigned";
  return {
    platform,
    root,
    appDir: opts.appDir,
    ...(opts.flavor ? { flavor: opts.flavor } : {}),
    configuration: opts.release ? "Release" : "Debug",
    appId: flavorAppId(identity.appId ?? "", opts.flavor?.config),
    version: opts.versionName ?? versions.version,
    buildNumber: opts.buildNumber ?? versions.build,
    signing: native.signing,
    commands: [...webCommands(opts, opts.flavor?.config), ...native.commands],
    produced: native.produced,
    artifact: artifactPath(opts, identity.appName, native.signing),
    ...(native.archive && unsigned ? { archive: native.archive } : {}),
    ...(native.exportOptions ? { exportOptions: native.exportOptions } : {}),
    warnings: native.warnings,
  };
}

/**
 * A command as the plan prints it: the program and its arguments, quoted where needed. The
 * environment (where secrets travel) is listed by name only.
 */
export function formatCommand(c: BuildCommand): string {
  const q = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  const env = c.env ? `[env: ${Object.keys(c.env).join(", ")}] ` : "";
  return `${env}${[c.cmd, ...c.args].map(q).join(" ")}`;
}

/** The plan as `mobile build --dry-run` prints it. */
export function formatBuildPlan(plan: MobileBuildPlan): string {
  const lines = [
    `  platform       ${plan.platform} (${plan.configuration})`,
    `  app id         ${plan.appId}${plan.flavor ? ` (flavor ${plan.flavor.name})` : ""}`,
    `  version        ${plan.version ?? "?"} (${plan.buildNumber ?? "?"})`,
    `  signing        ${plan.signing.detail}`,
    `  artifact       ${plan.artifact}`,
    "",
    "  commands:",
    ...plan.commands.map((c, i) => `    ${i + 1}. ${formatCommand(c)}`),
  ];
  for (const w of plan.warnings) lines.push("", `  warning: ${w}`);
  return lines.join("\n");
}

/** What a finished build produced (also the sidecar's content). */
export interface BuildArtifact {
  readonly platform: MobilePlatform;
  readonly path: string;
  readonly appId: string;
  readonly flavor?: string;
  readonly configuration: "Debug" | "Release";
  readonly version?: string;
  readonly buildNumber?: number;
  readonly signed: boolean;
  readonly bytes: number;
  readonly sha256: string;
  readonly builtAt: string;
}

/** Dependencies of {@linkcode runMobileBuild} (tests pass fakes). */
export interface MobileBuildDeps {
  readonly run: BuildRunner;
  readonly log: (line: string) => void;
  /** Writes the flavor's icons before the native build (`mobile assets`), when it has any. */
  readonly flavorAssets?: (snapshot: NativeSnapshot) => Promise<void>;
  readonly now?: () => Date;
}

/** Hex SHA-256 of a file. */
async function sha256File(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Zip the archive's .app into an unsigned .ipa (Payload/App.app). */
async function packageUnsignedIpa(plan: MobileBuildPlan, run: BuildRunner): Promise<void> {
  const apps = join(plan.archive!, "Products/Applications");
  const stage = join(plan.root, ".denext/mobile-build/ios/ipa");
  await Deno.remove(stage, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(stage, "Payload"), { recursive: true });
  const app = [...Deno.readDirSync(apps)].find((e) => e.name.endsWith(".app"));
  if (!app) throw new Error(`no .app in ${apps}`);
  for (
    const cmd of [
      { cmd: "cp", args: ["-R", join(apps, app.name), join(stage, "Payload")], cwd: stage },
      { cmd: "ditto", args: ["-c", "-k", "--keepParent", "Payload", plan.produced], cwd: stage },
    ]
  ) {
    await Deno.remove(plan.produced).catch(() => {});
    const { code } = await run(cmd);
    if (code !== 0) throw new Error(`\`${formatCommand(cmd)}\` exited with ${code}`);
  }
}

/** Run one command, throwing with its exit code. */
async function runStep(c: BuildCommand, deps: MobileBuildDeps): Promise<void> {
  deps.log(`\n  $ ${formatCommand(c)}`);
  const { code } = await deps.run(c);
  if (code !== 0) throw new Error(`\`${c.cmd} ${c.args[0] ?? ""}\` exited with ${code}`);
}

/** Apply the flavor and version overrides (recorded in `snapshot`). */
async function applyEdits(
  plan: MobileBuildPlan,
  opts: { versionName?: string; buildNumber?: number },
  snapshot: NativeSnapshot,
  deps: MobileBuildDeps,
): Promise<void> {
  if (plan.flavor) {
    const edits = await applyFlavor(plan.root, plan.platform, plan.flavor.config, snapshot);
    for (const c of edits.changes) deps.log(`  flavor ${plan.flavor.name}: ${c}`);
    for (const n of edits.notes) deps.log(`  flavor ${plan.flavor.name}: note: ${n}`);
    await deps.flavorAssets?.(snapshot);
  }
  if (plan.platform === "android") {
    for (
      const c of await applyAndroidVersions(plan.root, opts.buildNumber, opts.versionName, snapshot)
    ) {
      deps.log(`  ${c} (this build only)`);
    }
  }
  if (plan.exportOptions) {
    await Deno.mkdir(join(plan.exportOptions.path, ".."), { recursive: true });
    await Deno.writeTextFile(plan.exportOptions.path, plan.exportOptions.content);
  }
}

/** Why the Capacitor config's `server` block must not ship in a release, or undefined. */
async function devServerProblem(root: string): Promise<string | undefined> {
  const file = await capacitorConfigFile(root);
  if (!file) return undefined;
  const config = await readCapacitorConfig(file, await Deno.readTextFile(file));
  const server = config?.server as Record<string, unknown> | undefined;
  if (typeof server !== "object" || server === null) return undefined;
  if (isDevServerUrl(server.url)) return `server.url is a dev server (${server.url})`;
  if (server.cleartext === true) return "server.cleartext is true (plain http)";
  return undefined;
}

/**
 * Refuse a release build that would ship pointing at a dev server: a `denext mobile dev`
 * session's backup is on disk (the config is still the session's), or the Capacitor config's
 * `server` block names a LAN / loopback `http` URL or allows cleartext. A flavor's `serverUrl`
 * sets the server deliberately and is not second-guessed. `cap sync` rewrites the native copies
 * from this config, so checking it covers them.
 *
 * @param plan The plan about to run.
 * @throws {Error} When the release would carry a dev server.
 */
async function assertReleaseServer(plan: MobileBuildPlan): Promise<void> {
  if (plan.configuration !== "Release") return;
  if (await mobileDevBackupPresent(plan.root)) {
    throw new Error(
      "a `denext mobile dev` session is running, or a killed one left its backup " +
        "(.denext/mobile-dev-backup.json): the Capacitor config still points at the dev " +
        "server. End the session, or run `denext mobile dev --restore`, then build again",
    );
  }
  if (plan.flavor?.config.serverUrl) return;
  const problem = await devServerProblem(plan.root);
  if (problem) {
    throw new Error(
      `the Capacitor config's ${problem}: a release would load its UI from it. Remove it ` +
        "(`denext mobile dev --restore` puts back a config a dev session left), or set the " +
        "server deliberately with a flavor's `serverUrl`",
    );
  }
}

/**
 * Run a plan: the commands in order with the flavor applied around the native build, then copy
 * the artifact out and write its sidecar. Every temporary edit is restored, on failure too.
 *
 * @param plan From {@linkcode planMobileBuild}.
 * @param opts The build number / version overrides.
 * @param deps Runs commands and prints.
 * @returns The artifact.
 */
export async function runMobileBuild(
  plan: MobileBuildPlan,
  opts: { versionName?: string; buildNumber?: number },
  deps: MobileBuildDeps,
): Promise<BuildArtifact> {
  await assertReleaseServer(plan);
  const snapshot = new NativeSnapshot(plan.root);
  const exportFirst = plan.commands[0]?.args.includes("export") ? 1 : 0;
  try {
    // The export runs before the flavor is applied (it builds the web UI, not the shell).
    for (const c of plan.commands.slice(0, exportFirst)) await runStep(c, deps);
    await applyEdits(plan, opts, snapshot, deps);
    for (const c of plan.commands.slice(exportFirst)) await runStep(c, deps);
    if (plan.archive) await packageUnsignedIpa(plan, deps.run);
  } finally {
    const edited = snapshot.files.length;
    if (edited) {
      await snapshot.restore();
      deps.log(`\n  restored the ${edited} file(s) the flavor / version edits changed`);
    }
  }
  const outDir = join(plan.artifact, "..");
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.copyFile(plan.produced, plan.artifact);
  // What the file carries, not what the plan meant: a signing setup Gradle / Xcode ignored
  // must not be recorded as signed.
  const signed = checkArtifact(plan.artifact, await Deno.readFile(plan.artifact)).signed;
  if (!signed && plan.signing.mode !== "unsigned") {
    deps.log(
      `\n  warning: ${
        basename(plan.artifact)
      } is not signed, although ${plan.signing.detail} was configured`,
    );
  }
  const artifact: BuildArtifact = {
    platform: plan.platform,
    path: plan.artifact,
    appId: plan.appId,
    ...(plan.flavor ? { flavor: plan.flavor.name } : {}),
    configuration: plan.configuration,
    ...(plan.version === undefined ? {} : { version: plan.version }),
    ...(plan.buildNumber === undefined ? {} : { buildNumber: plan.buildNumber }),
    signed,
    bytes: (await Deno.stat(plan.artifact)).size,
    sha256: await sha256File(plan.artifact),
    builtAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await Deno.writeTextFile(`${plan.artifact}.json`, JSON.stringify(artifact, null, 2) + "\n");
  return artifact;
}
