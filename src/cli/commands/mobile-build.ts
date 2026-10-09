// The build / release actions of `denext mobile` (an EAS-class pipeline, run where you are):
//
//   denext mobile assets [--icon icon.png --splash splash.png]
//                        every iOS / Android icon and splash (adaptive + round + themed icons,
//                        dark variants) from one or two sources; @denext/photon, no npm
//   denext mobile build ios|android [--release] [--flavor <name>]
//                        export → cap sync → xcodebuild archive + export (.ipa) or gradle
//                        (.apk / .aab), signed from flags / env; dist/mobile/<platform>/
//   denext mobile submit ios|android [--dry-run]
//                        App Store Connect (API key + altool) / Google Play Developer API
//
// `assets` and `submit` never load the project's modules; `build --flavor` loads
// denext.config.* for `mobile.flavors` (the way `denext build` does).

import { resolve } from "@std/path";
import type { CommandContext, CommandLocks, FlagSpec } from "../command.ts";
import type { MobileConfig } from "../../server/config.ts";
import { resolveProject } from "../../build/paths.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { cliInvocation } from "../../ui/proc.ts";
import {
  type AssetPlatform,
  type AssetSources,
  colorFlag,
  findAssetSource,
  formatAssetsReport,
  generateMobileAssets,
} from "../../build/mobile-assets.ts";
import {
  capacitorPlaceholders,
  formatIconSearch,
  type IconSearch,
  type IconSource,
  preMaskedWarnings,
  resolveIconSource,
} from "../../build/mobile-icon-source.ts";
import {
  type BuildCommand,
  type BuildRunner,
  formatBuildPlan,
  iosHostError,
  type MobileBuildOptions,
  planMobileBuild,
  runMobileBuild,
  signingInputs,
} from "../../build/mobile-build.ts";
import {
  bumpBuildNumber,
  type MobilePlatform,
  type NativeSnapshot,
  type ResolvedFlavor,
  resolveFlavor,
  restoreInterruptedBuild,
} from "../../build/mobile-flavor.ts";
import {
  findLatestArtifact,
  formatSubmitReport,
  submitAndroid,
  submitIos,
  type SubmitReport,
} from "../../build/mobile-submit.ts";

/** Print `message` to stderr and exit 1. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

/** A string flag's value, or undefined. */
function str(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The Capacitor project: `--dir`, else `.`. */
function capRoot(ctx: CommandContext): string {
  return resolve(ctx.global.cwd ?? ".", str(ctx, "dir") ?? ".");
}

/** A path flag resolved against the working directory. */
function pathFlag(ctx: CommandContext, name: string): string | undefined {
  const v = str(ctx, name);
  return v === undefined ? undefined : resolve(ctx.global.cwd ?? ".", v);
}

/** The `ios` / `android` positional of build / submit. */
function platformArg(ctx: CommandContext, verb: string): MobilePlatform {
  const p = ctx.positionals[1];
  if (p === "ios" || p === "android") return p;
  fail(
    `denext mobile ${verb}: pass the platform, ios or android (got ${JSON.stringify(p ?? "")}).`,
  );
}

/** The flavor `--flavor` names, from the app's denext.config. */
async function flavorOf(ctx: CommandContext, appDir: string): Promise<ResolvedFlavor | undefined> {
  const name = str(ctx, "flavor");
  if (name === undefined) return undefined;
  const { config } = await resolveProject(appDir);
  return resolveFlavor((config as { mobile?: MobileConfig } | null)?.mobile, name);
}

/** A source flag, else the conventional file under assets/ or resources/. */
async function source(ctx: CommandContext, root: string, flag: string, kind: string) {
  return pathFlag(ctx, flag) ?? await findAssetSource(root, kind);
}

/** The asset sources, and the icon search when the icon was not given explicitly. */
interface ResolvedAssets {
  readonly spec: AssetSources;
  readonly search?: IconSearch;
  /** Warnings about an icon given explicitly (`--icon`, a flavor's): the search has its own. */
  readonly warnings?: readonly string[];
}

/** Why no icon could be found, with what was passed over. */
function noIconError(search: IconSearch): Error {
  const notes = search.notes.map((n) => `\n  note: ${n}`).join("");
  return new Error(
    "no icon: pass --icon <png>, set `mobile.icon` in denext.config.ts, or put assets/icon.png " +
      "(1024×1024 or larger) in the Capacitor project. Nothing usable was found in an Expo app " +
      "config, the web manifest, an apple-touch-icon or a PNG favicon" + notes,
  );
}

/** The background: a flavor's, else `--background-color`, else the source's, else white. */
function backgroundOf(ctx: CommandContext, flavor?: ResolvedFlavor, found?: IconSource) {
  const candidates: [string | undefined, string | undefined][] = [
    [flavor?.config.backgroundColor, `mobile.flavors.${flavor?.name}.backgroundColor`],
    [str(ctx, "background-color"), "--background-color"],
    [found?.background, found?.backgroundFrom],
  ];
  const [value, from] = candidates.find(([v]) => v !== undefined) ??
    ["#ffffff", "the default; pass --background-color"];
  return { background: colorFlag(value!, from ?? "background"), backgroundFrom: from };
}

/**
 * The asset sources: flags, a flavor's overrides, else the icon the project already has
 * (`mobile.icon`, assets/icon.png, an Expo config, the web manifest, apple-touch-icon, a
 * favicon; see ../../build/mobile-icon-source.ts), and the conventional files.
 */
async function assetSources(
  ctx: CommandContext,
  root: string,
  flavor?: ResolvedFlavor,
): Promise<ResolvedAssets> {
  const fromFlavor = (p: string | undefined) => (p === undefined ? undefined : resolve(root, p));
  const explicit = pathFlag(ctx, "icon") ?? fromFlavor(flavor?.config.icon);
  if (explicit) {
    return {
      spec: await specFor(ctx, root, explicit, flavor),
      warnings: await preMaskedWarnings(root, explicit),
    };
  }
  const search = await resolveIconSource(root);
  if (!search.source) throw noIconError(search);
  return { spec: await specFor(ctx, root, search.source.icon, flavor, search), search };
}

/** The layers and colours a resolved source brings (none for an explicit icon). */
function foundFields(found: IconSource | undefined, hint: string | undefined) {
  if (!found) return {};
  return {
    iconForeground: found.iconForeground,
    iconBackgroundImage: found.iconBackgroundImage,
    iconMonochrome: found.iconMonochrome,
    splashIcon: found.splashIcon,
    splashBackground: found.splashBackground &&
      colorFlag(found.splashBackground, "splash background"),
    darkBackground: found.darkBackground && colorFlag(found.darkBackground, "dark background"),
    hint,
  };
}

/** The full spec around `icon`: flags first, then the resolved source's fields, then assets/. */
async function specFor(
  ctx: CommandContext,
  root: string,
  icon: string,
  flavor?: ResolvedFlavor,
  search?: IconSearch,
): Promise<AssetSources> {
  const found = search?.source ?? undefined;
  const fields: Record<string, unknown> = foundFields(found, search?.hint);
  const spec: Record<string, unknown> = {
    ...fields,
    icon,
    iconForeground: await firstOf(
      pathFlag(ctx, "icon-foreground"),
      fields.iconForeground as string | undefined,
      () => findAssetSource(root, "iconForeground"),
    ),
    iconDark: await source(ctx, root, "icon-dark", "iconDark"),
    splash: await firstOf(
      flavor?.config.splash && resolve(root, flavor.config.splash),
      undefined,
      () => source(ctx, root, "splash", "splash"),
    ),
    splashDark: await source(ctx, root, "splash-dark", "splashDark"),
    ...backgroundOf(ctx, flavor, found),
    ...darkBackgroundFlag(ctx),
  };
  for (const key of Object.keys(spec)) if (!spec[key]) delete spec[key];
  return spec as unknown as AssetSources;
}

/** `a`, else `b`, else what `c` finds. */
async function firstOf(
  a: string | undefined,
  b: string | undefined,
  c: () => Promise<string | undefined>,
): Promise<string | undefined> {
  return a ?? b ?? await c();
}

/** `--dark-background-color`, parsed, when given. */
function darkBackgroundFlag(ctx: CommandContext) {
  const flag = str(ctx, "dark-background-color");
  return flag === undefined ? {} : { darkBackground: colorFlag(flag, "--dark-background-color") };
}

/** `--platform ios|android` for assets (default both). */
function assetPlatforms(ctx: CommandContext): AssetPlatform[] | undefined {
  const p = str(ctx, "platform");
  if (p === undefined) return undefined;
  if (p === "ios" || p === "android") return [p];
  fail(`denext mobile assets: --platform takes ios or android (got ${JSON.stringify(p)}).`);
}

/** `denext mobile assets`. */
export async function mobileAssets(ctx: CommandContext): Promise<void> {
  const root = capRoot(ctx);
  try {
    const { spec, search, warnings } = await assetSources(ctx, root);
    const report = await generateMobileAssets(root, spec, {
      platforms: assetPlatforms(ctx),
      dryRun: ctx.flags["dry-run"] === true,
    });
    if (ctx.global.json) {
      return console.log(
        JSON.stringify(
          search
            ? { ...report, iconSource: search }
            : { ...report, warnings: [...(warnings ?? []), ...report.warnings] },
        ),
      );
    }
    console.log(`\n  denext mobile assets${report.dryRun ? " --dry-run" : ""}  ▸  ${root}\n`);
    if (search) {
      console.log(
        formatIconSearch(search, { warnSize: false }).map((l) => `  ${l}`).join("\n") + "\n",
      );
    }
    console.log(
      formatAssetsReport({ ...report, warnings: [...(warnings ?? []), ...report.warnings] }),
    );
  } catch (err) {
    fail(`denext mobile assets: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Replace Capacitor's placeholder icon (and splash, when it is still the placeholder too) in
 * `platform`'s native project with the project's own icon, for good: `npx cap add` copies the
 * Capacitor logo, which App Review rejects and nobody wants on a home screen.
 *
 * @param ctx The command context (`--icon` / `--background-color` still apply).
 * @param root The Capacitor project.
 * @param platform The platform being built.
 * @param dryRun Say what would happen, write nothing.
 * @param log Prints a line.
 */
export async function replacePlaceholderIcons(
  ctx: CommandContext,
  root: string,
  platform: MobilePlatform,
  dryRun: boolean,
  log: (line: string) => void,
): Promise<void> {
  const icons = await capacitorPlaceholders(root, platform, "icon");
  if (icons.length === 0) return;
  let resolved: ResolvedAssets;
  try {
    resolved = await assetSources(ctx, root);
  } catch (err) {
    log(
      `  warning: ${platform} still has Capacitor's placeholder icon (${icons[0]}), which App ` +
        `Review rejects: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const kinds: ("icon" | "splash")[] = ["icon"];
  if ((await capacitorPlaceholders(root, platform, "splash")).length) kinds.push("splash");
  const lines = resolved.search
    ? formatIconSearch(resolved.search, { warnSize: false })
    : [`icon: ${resolved.spec.icon}`, ...(resolved.warnings ?? []).map((w) => `warning: ${w}`)];
  const report = await generateMobileAssets(root, resolved.spec, {
    platforms: [platform],
    kinds,
    dryRun,
  });
  log(
    `  ${platform} has Capacitor's placeholder ${kinds.join(" and ")}: ${
      dryRun ? "would replace" : "replaced"
    } ${report.files.length} files (kept after the build; \`denext mobile assets\` redoes them)`,
  );
  for (const l of [...lines, ...report.warnings.map((w) => `warning: ${w}`)]) log(`    ${l}`);
}

/**
 * Run a command with the terminal attached; `env` is added to the inherited environment (a Yarn
 * install's no-scripts switches, signing secrets). Shared by `denext mobile build`, `submit` and
 * `add`.
 */
export const runInheritedCommand: BuildRunner = async ({ cmd, args, cwd, env }) => {
  try {
    const { code } = await new Deno.Command(cmd, {
      args: [...args],
      cwd,
      ...(env ? { env: { ...env } } : {}),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    return { code };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`\`${cmd}\` was not found (is it installed, and on PATH?)`);
    }
    throw err;
  }
};

/** A positive integer flag, or undefined. */
function intFlag(ctx: CommandContext, name: string): number | undefined {
  const v = ctx.flags[name];
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) {
    fail(`denext mobile build: --${name} takes a positive integer.`);
  }
  return n;
}

/** The build options from the flags. */
async function buildOptions(
  ctx: CommandContext,
  platform: MobilePlatform,
): Promise<MobileBuildOptions> {
  const root = capRoot(ctx);
  const appDir = pathFlag(ctx, "app") ?? root;
  const flavor = await flavorOf(ctx, appDir);
  return {
    root,
    appDir,
    platform,
    release: ctx.flags.release === true,
    ...(flavor ? { flavor } : {}),
    unsigned: ctx.flags.unsigned === true,
    apk: ctx.flags.apk === true,
    buildNumber: intFlag(ctx, "build-number"),
    versionName: str(ctx, "version-name"),
    skipExport: ctx.flags["skip-export"] === true,
    jobs: intFlag(ctx, "jobs"),
    exportMethod: str(ctx, "export-method"),
    exportOptions: pathFlag(ctx, "export-options"),
    outDir: pathFlag(ctx, "out"),
    signing: signingInputs(
      {
        team: str(ctx, "team"),
        ascKeyPath: pathFlag(ctx, "asc-key"),
        ascKeyId: str(ctx, "asc-key-id"),
        ascIssuerId: str(ctx, "asc-issuer"),
        keystore: pathFlag(ctx, "keystore"),
        keyAlias: str(ctx, "key-alias"),
      },
      (n) => Deno.env.get(n),
    ),
    cli: cliInvocation({ dir: appDir }),
    deno: denoExecutable(),
    gradleOpts: Deno.env.get("GRADLE_OPTS"),
  };
}

/** Writes the flavor's icons and splash (when it names any), saving each file first. */
function flavorAssetsWriter(
  ctx: CommandContext,
  opts: MobileBuildOptions,
): ((snapshot: NativeSnapshot) => Promise<void>) | undefined {
  const f = opts.flavor;
  if (!f || !(f.config.icon || f.config.splash || f.config.backgroundColor)) return undefined;
  return async (snapshot) => {
    const { spec } = await assetSources(ctx, opts.root, f);
    const platforms = [opts.platform];
    const plan = await generateMobileAssets(opts.root, spec, { platforms, dryRun: true });
    for (const file of plan.files) await snapshot.save(resolve(opts.root, file.path));
    await generateMobileAssets(opts.root, spec, { platforms });
    console.log(`  flavor ${f.name}: ${plan.files.length} icon / splash files`);
  };
}

/** `denext mobile build --restore`. */
async function restoreBuild(ctx: CommandContext): Promise<void> {
  const restored = await restoreInterruptedBuild(capRoot(ctx));
  if (ctx.global.json) return console.log(JSON.stringify({ restored }));
  console.log(
    restored.length
      ? restored.map((f) => `  restored  ${f}`).join("\n")
      : "  nothing to restore (no interrupted build)",
  );
}

/** Put back what an interrupted build left, saying so. */
async function recoverFirst(root: string): Promise<void> {
  const restored = await restoreInterruptedBuild(root);
  if (restored.length) {
    console.log(`  restored ${restored.length} file(s) an interrupted build left changed`);
  }
}

/**
 * The locks `denext mobile build` holds: its output dir (`dist/mobile`, or `--out`) as a package
 * output — rank 0, so the `denext export` child it spawns takes the build dir and out/ itself.
 * A `--dry-run` or `--restore` writes no build and locks nothing.
 *
 * @param ctx The command context.
 * @returns The locks, or undefined.
 */
export function mobileBuildLocks(ctx: CommandContext): CommandLocks | undefined {
  if (ctx.flags["dry-run"] === true || ctx.flags.restore === true) return undefined;
  const root = capRoot(ctx);
  return { projectDir: root, packageDirs: [pathFlag(ctx, "out") ?? resolve(root, "dist/mobile")] };
}

/** Refuse, saying why, a build this host cannot run (iOS off macOS). */
function assertHostBuilds(platform: MobilePlatform): void {
  const hostError = platform === "ios" ? iosHostError("build") : undefined;
  if (hostError) throw new Error(hostError);
}

/**
 * `denext mobile build ios|android`.
 *
 * @param ctx The command context.
 * @param run Runs the commands (tests pass a fake).
 */
export async function mobileBuild(
  ctx: CommandContext,
  run: BuildRunner = runInheritedCommand,
): Promise<void> {
  if (ctx.flags.restore === true) return await restoreBuild(ctx);
  const platform = platformArg(ctx, "build");
  try {
    const opts = await buildOptions(ctx, platform);
    // Put back what a killed build left before reading the project (not in a dry run).
    if (ctx.flags["dry-run"] !== true) await recoverFirst(opts.root);
    const plan = await planMobileBuild(opts);
    if (ctx.flags["dry-run"] === true) {
      if (ctx.global.json) {
        return console.log(JSON.stringify({ ...plan, commands: plan.commands.map(redacted) }));
      }
      console.log(`\n  denext mobile build ${platform} --dry-run (nothing runs)\n`);
      await replacePlaceholderIcons(ctx, opts.root, platform, true, (l) => console.log(l));
      return console.log(formatBuildPlan(plan));
    }
    assertHostBuilds(platform);
    if (ctx.flags.bump === true) {
      const b = await bumpBuildNumber(opts.root, platform);
      console.log(`  build number ${b.from} → ${b.to} (${b.file}; commit it)`);
      Object.assign(plan, { buildNumber: opts.buildNumber ?? b.to });
    }
    if (!ctx.global.json) {
      console.log(`\n  denext mobile build ${platform}\n\n${formatBuildPlan(plan)}`);
    }
    await replacePlaceholderIcons(ctx, opts.root, platform, false, buildLog(ctx));
    const artifact = await runMobileBuild(plan, opts, {
      run,
      log: (line) => console.log(line),
      flavorAssets: flavorAssetsWriter(ctx, opts),
    });
    if (ctx.global.json) return console.log(JSON.stringify(artifact));
    console.log(
      `\n  built ${artifact.path}\n  ${artifact.appId} ${artifact.version ?? "?"} (${
        artifact.buildNumber ?? "?"
      }), ${artifact.signed ? "signed" : "unsigned"}, ${
        (artifact.bytes / 1048576).toFixed(1)
      } MB, sha256 ${artifact.sha256.slice(0, 16)}…`,
    );
  } catch (err) {
    fail(`denext mobile build: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Where build progress lines go: stdout, or stderr when stdout carries `--json`. */
function buildLog(ctx: CommandContext): (line: string) => void {
  return ctx.global.json ? (l) => console.error(l) : (l) => console.log(l);
}

/** A command with its env values replaced by `***` (for --json). */
function redacted(c: BuildCommand): BuildCommand {
  return c.env ? { ...c, env: Object.fromEntries(Object.keys(c.env).map((k) => [k, "***"])) } : c;
}

/** The artifact to submit: `--file`, else the newest build of the platform (and flavor). */
async function submitArtifact(
  ctx: CommandContext,
  platform: MobilePlatform,
): Promise<{ path: string; appId?: string }> {
  const file = pathFlag(ctx, "file");
  if (file) return { path: file };
  const outDir = pathFlag(ctx, "out") ?? resolve(capRoot(ctx), "dist/mobile");
  const latest = await findLatestArtifact(outDir, platform, str(ctx, "flavor"));
  if (!latest) {
    throw new Error(
      `no ${platform} build in ${outDir}: run \`denext mobile build ${platform} --release\` first, or pass --file`,
    );
  }
  return { path: latest.path, appId: latest.meta.appId };
}

/** The fetch, the command runner and the clock `submit` uses. */
type SubmitVerbDeps = { fetch: typeof fetch; run: BuildRunner; now: () => number };

/** What both platforms' submits share: the artifact, the app id and the mode flags. */
interface SubmitTarget {
  readonly artifact: string;
  readonly appId?: string;
  readonly dryRun: boolean;
  readonly offline: boolean;
}

/** `submit ios`: the API key from flags / env. */
function submitIosFrom(ctx: CommandContext, t: SubmitTarget, deps: SubmitVerbDeps) {
  const hostError = t.dryRun ? undefined : iosHostError("submit");
  if (hostError) throw new Error(hostError);
  const s = signingInputs(
    {
      ascKeyPath: pathFlag(ctx, "asc-key"),
      ascKeyId: str(ctx, "asc-key-id"),
      ascIssuerId: str(ctx, "asc-issuer"),
    },
    (n) => Deno.env.get(n),
  );
  return submitIos({
    artifact: t.artifact,
    bundleId: t.appId,
    creds: { keyPath: s.ascKeyPath, keyId: s.ascKeyId, issuerId: s.ascIssuerId },
    dryRun: t.dryRun,
    offline: t.offline,
  }, deps);
}

/** The Play service account: `--service-account`, else the environment. */
function serviceAccountPath(ctx: CommandContext): string | undefined {
  const fromEnv = [
    Deno.env.get("DENEXT_PLAY_SERVICE_ACCOUNT"),
    Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS"),
  ].find((v) => v);
  return pathFlag(ctx, "service-account") ??
    (fromEnv ? resolve(ctx.global.cwd ?? ".", fromEnv) : undefined);
}

/** `submit android`: the service account, track and status from flags / env. */
function submitAndroidFrom(ctx: CommandContext, t: SubmitTarget, deps: SubmitVerbDeps) {
  return submitAndroid({
    artifact: t.artifact,
    packageName: t.appId,
    serviceAccount: serviceAccountPath(ctx),
    track: str(ctx, "track") ?? "internal",
    status: ctx.flags.draft === true ? "draft" : "completed",
    dryRun: t.dryRun,
    offline: t.offline,
  }, deps);
}

/** Print the report (or its JSON). */
function printSubmit(ctx: CommandContext, platform: MobilePlatform, report: SubmitReport): void {
  if (ctx.global.json) return console.log(JSON.stringify(report));
  console.log(`\n  denext mobile submit ${platform}${report.dryRun ? " --dry-run" : ""}\n`);
  console.log(formatSubmitReport(report));
}

/**
 * `denext mobile submit ios|android`.
 *
 * @param ctx The command context.
 * @param deps The fetch, the command runner and the clock (tests pass fakes).
 */
export async function mobileSubmit(
  ctx: CommandContext,
  deps: SubmitVerbDeps = { fetch: globalThis.fetch, run: runInheritedCommand, now: Date.now },
): Promise<void> {
  const platform = platformArg(ctx, "submit");
  let report: SubmitReport;
  try {
    const artifact = await submitArtifact(ctx, platform);
    const target: SubmitTarget = {
      artifact: artifact.path,
      appId: str(ctx, "app-id") ?? artifact.appId,
      dryRun: ctx.flags["dry-run"] === true,
      offline: ctx.flags.offline === true,
    };
    report = platform === "ios"
      ? await submitIosFrom(ctx, target, deps)
      : await submitAndroidFrom(ctx, target, deps);
  } catch (err) {
    fail(`denext mobile submit: ${err instanceof Error ? err.message : String(err)}`);
  }
  printSubmit(ctx, platform, report);
  if (report.checks.some((c) => !c.ok)) Deno.exit(1);
}

/** The flags the build actions add to the `mobile` verb. */
export const MOBILE_BUILD_FLAGS: readonly FlagSpec[] = [
  {
    name: "icon",
    type: "string",
    valueName: "<png>",
    help:
      "assets: the app icon (default: the project's own: mobile.icon, assets/icon.png, an Expo app config, the web manifest, the apple-touch-icon)",
  },
  {
    name: "icon-foreground",
    type: "string",
    valueName: "<png>",
    help:
      "assets: Android's adaptive foreground layer (default: assets/icon-foreground.png, else the icon)",
  },
  {
    name: "icon-dark",
    type: "string",
    valueName: "<png>",
    help: "assets: the iOS 18 dark icon (default: assets/icon-dark.png)",
  },
  {
    name: "splash",
    type: "string",
    valueName: "<png>",
    help: "assets: the splash (default: assets/splash.png, else the icon on the background)",
  },
  {
    name: "splash-dark",
    type: "string",
    valueName: "<png>",
    help: "assets: the dark splash (default: assets/splash-dark.png)",
  },
  {
    name: "background-color",
    type: "string",
    valueName: "<#hex>",
    help: "assets: icon and splash background (default: #ffffff)",
  },
  {
    name: "dark-background-color",
    type: "string",
    valueName: "<#hex>",
    help: "assets: the dark splash background (writes the dark variants)",
  },
  {
    name: "flavor",
    type: "string",
    valueName: "<name>",
    help: "build, submit: a flavor from denext.config mobile.flavors",
  },
  {
    name: "unsigned",
    type: "boolean",
    help: "build ios: archive without signing (an unsigned .ipa for CI)",
  },
  { name: "apk", type: "boolean", help: "build android --release: an .apk instead of an .aab" },
  {
    name: "build-number",
    type: "number",
    valueName: "<n>",
    help: "build: the build number for this build only",
  },
  {
    name: "version-name",
    type: "string",
    valueName: "<x.y.z>",
    help: "build: the version for this build only",
  },
  {
    name: "bump",
    type: "boolean",
    help: "build: increment the build number in the native sources first (commit it)",
  },
  {
    name: "skip-export",
    type: "boolean",
    help: "build: skip `denext export` (the web export is already there)",
  },
  {
    name: "jobs",
    type: "number",
    valueName: "<n>",
    help: "build: parallel jobs (xcodebuild -jobs, gradle --max-workers)",
  },
  {
    name: "team",
    type: "string",
    valueName: "<id>",
    help: "build ios: the Apple team id (default: $DENEXT_IOS_TEAM, else the project's)",
  },
  {
    name: "asc-key",
    type: "string",
    valueName: "<p8>",
    help: "build, submit ios: App Store Connect API key file (default: $DENEXT_ASC_KEY_PATH)",
  },
  {
    name: "asc-key-id",
    type: "string",
    valueName: "<id>",
    help: "build, submit ios: its key id (default: $DENEXT_ASC_KEY_ID, or AuthKey_<id>.p8)",
  },
  {
    name: "asc-issuer",
    type: "string",
    valueName: "<id>",
    help: "build, submit ios: its issuer id (default: $DENEXT_ASC_ISSUER_ID)",
  },
  {
    name: "export-method",
    type: "string",
    valueName: "<method>",
    help:
      "build ios: app-store-connect (--release default), release-testing, debugging, enterprise",
  },
  {
    name: "export-options",
    type: "string",
    valueName: "<plist>",
    help: "build ios: your own ExportOptions.plist",
  },
  {
    name: "keystore",
    type: "string",
    valueName: "<jks>",
    help: "build android --release: the upload keystore (default: $DENEXT_ANDROID_KEYSTORE)",
  },
  {
    name: "key-alias",
    type: "string",
    valueName: "<alias>",
    help: "build android: the key alias (default: $DENEXT_ANDROID_KEY_ALIAS)",
  },
  {
    name: "out",
    type: "string",
    valueName: "<dir>",
    help: "build, submit: the artifact directory (default: dist/mobile)",
  },
  {
    name: "file",
    type: "string",
    valueName: "<ipa|aab|apk>",
    help: "submit: the artifact (default: the newest build)",
  },
  {
    name: "app-id",
    type: "string",
    valueName: "<id>",
    help: "submit: the bundle id / package name (default: the build's)",
  },
  {
    name: "service-account",
    type: "string",
    valueName: "<json>",
    help: "submit android: the Play service-account key (default: $DENEXT_PLAY_SERVICE_ACCOUNT)",
  },
  {
    name: "track",
    type: "string",
    valueName: "<track>",
    help: "submit android: the release track (default: internal)",
  },
  { name: "draft", type: "boolean", help: "submit android: leave the release as a draft" },
  { name: "offline", type: "boolean", help: "submit --dry-run: skip the network checks" },
];

/** The build actions' usage lines. */
export const MOBILE_BUILD_USAGE =
  "  denext mobile assets          Every icon and splash from the project's icon (+ splash.png)\n" +
  "  denext mobile assets --icon logo.png --background-color '#0f172a' --dark-background-color '#000'\n" +
  "                                Icons + splash, dark variants included\n" +
  "  denext mobile build android   Export, cap sync, gradle assembleDebug → dist/mobile/android/*.apk\n" +
  "  denext mobile build ios --release\n" +
  "                                Export, cap sync, xcodebuild archive + export → a signed .ipa\n" +
  "  denext mobile build ios --unsigned\n" +
  "                                An unsigned .ipa (CI without certificates)\n" +
  "  denext mobile build android --release --flavor staging\n" +
  "                                A signed .aab with the staging flavor's id, name and URL\n" +
  "  denext mobile build ios --dry-run\n" +
  "                                The plan: commands, signing, artifact (nothing runs)\n" +
  "  denext mobile submit ios --dry-run\n" +
  "                                Check the .ipa, the API key and the app in App Store Connect\n" +
  "  denext mobile submit android --track internal\n" +
  "                                Upload the newest .aab to Google Play's internal track\n";

/** The build actions' long help. */
export const MOBILE_BUILD_HELP = "\n" +
  "  assets: writes the iOS app icon (1024², RGB: App Store Connect refuses an alpha channel)\n" +
  "  and its iOS 18 dark variant, the iOS splash set, Android's legacy, round, adaptive\n" +
  "  (foreground + background colour) and themed (monochrome) launcher icons for every density,\n" +
  "  and the portrait / landscape splash drawables; the dark splash variants (asset catalog\n" +
  "  appearances, drawable-night) when --splash-dark or --dark-background-color is given.\n" +
  "  Without --icon the icon is the project's own, and the report names it: denext.config\n" +
  "  mobile.icon, assets/icon.png, an Expo app config's icon (a sibling monorepo app's too;\n" +
  "  app.config.ts is read statically, never run), the web manifest's largest icon, the\n" +
  "  apple-touch-icon, then the largest PNG favicon. Under 1024² it is upscaled with a warning;\n" +
  "  transparency is flattened onto the background for iOS. The other sources default to\n" +
  "  assets/ (or resources/): icon-foreground.png, icon-dark.png, splash.png, splash-dark.png.\n" +
  "  Decoding and resizing run on @denext/photon (wasm).\n" +
  "\n" +
  "  build: `denext export` (--app, default the Capacitor project; a flavor's env is added),\n" +
  "  the flavor's edits, `npx cap sync <platform>`, then the native build. Without --release:\n" +
  "  a Debug build (Android: a debug-signed .apk). iOS signs automatically (-allowProvisioning\n" +
  "  Updates) for --team / DENEXT_IOS_TEAM, with DENEXT_ASC_KEY_PATH / _KEY_ID / _ISSUER_ID as the\n" +
  "  API key on a machine with no Apple ID signed in; --unsigned needs no certificate. Android\n" +
  "  --release signs with DENEXT_ANDROID_KEYSTORE, DENEXT_ANDROID_KEY_ALIAS,\n" +
  "  DENEXT_ANDROID_KEYSTORE_PASSWORD and DENEXT_ANDROID_KEY_PASSWORD, passed to Gradle through\n" +
  "  the environment (never argv, never printed). --build-number / --version-name apply to this\n" +
  "  build only; --bump increments the build number in the sources. Flavors\n" +
  "  (denext.config mobile.flavors) change the app id, name, server.url and icons for the build\n" +
  "  and are restored afterwards; a killed build is restored by the next one or by\n" +
  "  `mobile build --restore`. Capacitor's placeholder icon (and splash), left by `cap add`, is\n" +
  "  replaced for good with the project's icon (as `assets` finds it). The artifact and a\n" +
  "  <artifact>.json sidecar land in dist/mobile/<platform>[-<flavor>]/.\n" +
  "\n" +
  "  submit: checks the artifact (signed, well formed) and the credentials, then uploads: iOS\n" +
  "  with `xcrun altool --upload-app` and the App Store Connect API key, Android through the\n" +
  "  Google Play Developer API with a service account (edit → upload → track → commit).\n" +
  "  --dry-run uploads nothing: it signs a token with the key and, unless --offline, looks the\n" +
  "  app up (App Store Connect) or opens and deletes an edit (Play). Exits 1 on a failed check.";
