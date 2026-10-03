// `denext desktop <run|build|dev|package|add|publish-update>` — promotes the scaffold-generated
// desktop `deno task`s to first-class verbs over the `denext/desktop` runtime.
//
//   run      export the SPA, build the app with `deno desktop` into a temp dir (the packaging
//            scripts' least-privilege flags), launch it and stream its output until it exits
//   build    export the SPA to out/ (what the desktop window serves)
//   dev      live reload: start (or attach to) `denext dev`, then build and open a window whose
//            runtime reverse-proxies EVERYTHING (HTTP + HMR) to it, so edits hot-reload in it
//   package  build the app and its installers with scripts/package-<os>.ts — macOS (.app +
//            .dmg / .pkg, signed and notarized), Linux (.tar.gz + .deb, .rpm / AppImage) or
//            Windows (.msi / .zip, Authenticode-signed when a cert is supplied); `--target-os`
//            cross-builds Linux and Windows from any OS, macOS packages on a Mac.
//   add      enable Deno Desktop capabilities in desktop.capabilities (./desktop-add.ts)
//   publish-update  pack a packaged app into a signed full-app update (archive + app-update.json)
//
// `run`/`build`/`package` serve a static export over loopback. `dev` is the desktop half of
// dev-server attach (the Metro model): the window proxies to `denext dev` so the CSP and the dev
// origin gate stay untouched (`location.origin` is still loopback).
//
// A single command whose first positional selects the action, since the framework
// models flat verbs; the second positional is the project dir.

import { dirname, join, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runBuildStep, spawnDenoAndExit } from "../shared.ts";
import { startOrAttachDevServer, waitForShutdownSignal } from "../dev-attach.ts";
import { staticExport } from "../../build/export.ts";
import { withProjectLocks } from "../../build/project-locks.ts";
import { desktopDevTarget, type DesktopWindow, runDesktopDev } from "../../build/desktop-dev.ts";
import { DESKTOP_DEV_LAN_ENV, DESKTOP_DEV_URL_ENV } from "../../build/desktop.ts";
import type { DesktopOs } from "../../build/desktop-capabilities.ts";
import {
  desktopLaunchBuildPlan,
  desktopLaunchExecutable,
  desktopLaunchScratchDir,
  writeDesktopDevEntry,
} from "../../build/desktop-launch.ts";
import { scaffoldFiles } from "../../build/scaffold.ts";
import { createUnifiedDiff } from "../../build/patch-diff.ts";
import { DESKTOP_ADD_FLAGS, desktopAdd } from "./desktop-add.ts";
import { desktopPublishUpdate, PUBLISH_UPDATE_FLAGS } from "./desktop-publish-update.ts";
import { type ProjectPaths, resolveProject } from "../../build/paths.ts";
import { bundleDesktopPreload, DESKTOP_PRELOAD_ENV } from "../../build/desktop-preload.ts";
import { syncDesktopAppConfigAt, unpackagedLaunchEnv } from "../../build/desktop-app-config.ts";
import {
  DESKTOP_RUNTIME_ATTEST_ENV,
  DESKTOP_RUNTIME_VERIFY_ENV,
  resolveDesktopRuntimeEnv,
} from "../../build/desktop-runtime.ts";
import { denoExecutable } from "../../build/bundle.ts";
import { desktopDenoFlags } from "../../desktop/deno-flags.ts";
import { desktopPnpmWorkspaceHint } from "../../build/desktop-deno-flags.ts";

/** The project dir for a `desktop <action> [dir]` invocation (positional[1]). */
function desktopDir(ctx: CommandContext): string {
  return resolve(
    ctx.global.cwd ?? (ctx.positionals[0] === "add" ? "." : ctx.positionals[1]) ?? ".",
  );
}

/**
 * Export the SPA to out/, holding the build-dir and out/ locks for the export only — `desktop
 * run` then keeps its window open for as long as the user likes, and must not block builds.
 */
async function exportSpa(dir: string): Promise<void> {
  console.log(`\n  denext desktop — exporting SPA  ▸  ${dir}\n`);
  const result = await withProjectLocks(
    { projectDir: dir, buildDir: "exclusive", outputDirs: ["out"] },
    () => runBuildStep(() => staticExport(dir), "desktop export"),
  );
  console.log(`  Exported ${result.pages} page(s) to ${result.outDir}\n`);
}

export const desktopCommand: CommandSpec = {
  name: "desktop",
  summary: "Build/run/package the app as a native desktop app",
  loadsModules: true,
  moduleDir: desktopDir,
  // `package` writes dist/ and runs the packaging script, whose `deno task export` child takes
  // the build dir and out/ itself — so the parent locks dist/ only (rank 0, below the child's).
  locks: (ctx) =>
    ctx.positionals[0] === "package" && ctx.flags["regenerate-scripts"] !== true
      ? { projectDir: desktopDir(ctx), packageDirs: ["dist"] }
      : undefined,
  usage:
    "  denext desktop run                     Export, build into a temp dir and open the window\n" +
    "  denext desktop build                   Export the SPA to out/\n" +
    "  denext desktop dev                     Live reload: open a window proxied to `denext dev`\n" +
    "  denext desktop dev --lan               …attach to a dev server on your network (loopback else)\n" +
    "  denext desktop package                 Build a distributable bundle for the host OS\n" +
    "  denext desktop package --target-os windows  Cross-build (Linux and Windows from any OS)\n" +
    "  denext desktop package --format msi,zip    Pick the installers (dmg|pkg, tar.gz|deb|rpm|appimage, msi|zip)\n" +
    "  denext desktop package --regenerate-scripts  Rewrite scripts/package-*.ts from the current template\n" +
    "  denext desktop add secure-store fs     Enable capabilities in desktop.capabilities (--list, --dry-run)\n" +
    "  denext desktop publish-update --artifact dist/MyApp.app --url-base https://updates.example.com/myapp/\n" +
    "                                         Sign a full-app update (archive + app-update.json)",
  positionals: [
    {
      name: "action",
      help: "run | build | dev | package | add | publish-update (default: run)",
    },
    { name: "dir", help: "Project directory (default: .)" },
  ],
  flags: [
    {
      name: "entry",
      type: "string",
      valueName: "<file>",
      help: "Desktop entry (default: desktop.ts)",
    },
    {
      name: "target-os",
      type: "string",
      valueName: "<os>",
      help: "package for: macos | linux | windows (default: the host OS; Linux and Windows " +
        "cross-build from any OS, macOS packages on a Mac)",
    },
    {
      name: "port",
      alias: "p",
      type: "number",
      valueName: "<port>",
      help: "dev: the dev server port to start or attach to (default: 3000)",
    },
    {
      name: "host",
      type: "string",
      valueName: "<host>",
      help: "dev: the host to bind and proxy to (default: localhost; non-loopback needs --lan)",
    },
    {
      name: "lan",
      type: "boolean",
      help: "dev: attach to a dev server on the LAN (a non-loopback target; opt in explicitly)",
    },
    {
      name: "format",
      type: "string",
      valueName: "<list>",
      help: "package: the installers to build, comma-separated — macOS dmg | pkg; Linux tar.gz | " +
        "deb | rpm | appimage; Windows msi | zip (default: desktop.installers.<os>, else " +
        "dmg / tar.gz,deb / msi)",
    },
    {
      name: "regenerate-scripts",
      type: "boolean",
      help:
        "package: rewrite scripts/package-*.ts from the current template (least-privilege flags), " +
        "keeping a .bak of any file that differs; adopt the current scripts in an existing project",
    },
    {
      name: "verify-runtime",
      type: "boolean",
      help: "run | dev | package: re-hash the cached Deno Desktop runtime before use " +
        "(DENEXT_DESKTOP_RUNTIME_VERIFY=1)",
    },
    {
      name: "attest-runtime",
      type: "boolean",
      help: "run | dev | package: also check a downloaded runtime's build provenance with " +
        "`gh attestation verify` (DENEXT_DESKTOP_RUNTIME_ATTEST=1; needs gh)",
    },
    ...DESKTOP_ADD_FLAGS,
    ...PUBLISH_UPDATE_FLAGS,
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0] ?? "run";
    // Read by resolveDesktopRuntimeEnv here AND by a packaging script's own call (inherited env).
    if (ctx.flags["verify-runtime"] === true) Deno.env.set(DESKTOP_RUNTIME_VERIFY_ENV, "1");
    if (ctx.flags["attest-runtime"] === true) Deno.env.set(DESKTOP_RUNTIME_ATTEST_ENV, "1");
    const dir = desktopDir(ctx);
    const entry = (ctx.flags.entry as string | undefined) ?? "desktop.ts";
    if (action === "build") return await exportSpa(dir);
    if (action === "run") return await runDesktop(dir, entry);
    if (action === "dev") return await runDesktopDevSession(ctx, dir, entry);
    if (action === "package") return await packageDesktop(ctx, dir);
    if (action === "add") return await desktopAdd(ctx);
    if (action === "publish-update") return await desktopPublishUpdate(ctx, dir);
    console.error(
      `denext desktop: unknown action "${action}" (expected run | build | dev | package | add | ` +
        `publish-update).`,
    );
    Deno.exit(1);
  },
};

/** Print `message` to stderr and exit 1. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

/** What an unpackaged window is built and launched with. */
interface DesktopWindowLaunch {
  /** The loaded project config. */
  readonly config: unknown;
  /** The launched executable's env (`LAUFEY_*`, and in `dev` the preload). */
  readonly env: Record<string, string>;
  /** The build's env: denext's pinned runtime (`DENORT_DESKTOP_BIN` + `LAUFEY_DEV_DIR`). */
  readonly buildEnv: Record<string, string>;
  /** `desktop.denoFlags`. */
  readonly denoFlags: string[];
  /** The project's build directory (`.denext/`), where `dev` writes its generated entry. */
  readonly buildDir: string;
}

/**
 * `desktop.denoFlags` of the project (refused flags throw), after printing the pnpm-workspace hint
 * when it applies.
 */
async function projectDenoFlags(dir: string, config: unknown): Promise<string[]> {
  const flags = desktopDenoFlags(config);
  const hint = await desktopPnpmWorkspaceHint(dir, flags);
  if (hint) {
    console.warn(`  ⚠ ${hint}
`);
  }
  return flags;
}

/**
 * Prepare an UNPACKAGED window (`desktop run` / `dev`): sync `.deno-desktop/app.json` (the
 * configured origin + identifier, embedded through deno.json `compile.include`), resolve denext's
 * pinned Deno Desktop runtime for the build (downloaded and verified on first use; nothing under
 * `DENEXT_DESKTOP_RUNTIME=stock`), and the webview backend's launch settings as `LAUFEY_*` env for
 * the launched executable (the scratch bundle has no `laufey-launch.json`; DevTools on in `dev`,
 * and in `run` unless `desktop.inspectable: false`). Single instance is left out on purpose: a dev
 * window must never hand itself to an installed copy of the same app and exit.
 */
async function prepareDesktopWindow(dir: string, dev = false): Promise<DesktopWindowLaunch> {
  const paths = await resolveProject(dir);
  const { config } = paths;
  const denoFlags = await projectDenoFlags(dir, config);
  await syncDesktopAppConfigAt(dir, config);
  // An unpackaged window falls back to the stock runtime (with a warning) for a `deno` that is not
  // the runtime's exact version; packaging stays strict.
  const runtime = await resolveDesktopRuntimeEnv({
    projectDir: dir,
    deno: denoExecutable(),
    onDenoMismatch: "stock",
  });
  const env = {
    ...unpackagedLaunchEnv(config, dev ? "dev" : "run"),
    ...(dev ? await devPreloadEnv(paths) : {}),
  };
  return { config, env, buildEnv: runtime.env, denoFlags, buildDir: paths.outDir };
}

/**
 * `desktop dev` only: bundle `desktop.preload` (unminified) into `.denext/` and point the window's
 * runtime at it — live-reload mode serves the dev server's pages, not the export, so the export's
 * preload would be stale or missing. Rebuilt per session (edit the preload → restart the session).
 */
async function devPreloadEnv(paths: ProjectPaths): Promise<Record<string, string>> {
  const preload = paths.config?.desktop?.preload;
  if (!preload) return {};
  const outFile = join(paths.outDir, "desktop-preload.dev.js");
  await bundleDesktopPreload({
    projectDir: paths.projectDir,
    preload,
    configPath: paths.configPath,
    outFile,
    minify: false,
  });
  return { [DESKTOP_PRELOAD_ENV]: outFile };
}

/** The host OS as `deno desktop` targets it, or a failure on an OS it does not build for. */
function hostDesktopOs(): DesktopOs {
  const os = Deno.build.os;
  if (os === "darwin" || os === "linux" || os === "windows") return os;
  throw new Error(`deno desktop does not build for ${os}.`);
}

/** A built scratch app: the executable to launch, and the scratch directory to remove after. */
interface BuiltDesktopWindow {
  readonly exe: string;
  readonly scratch: string;
}

/**
 * Build the app for an unpackaged window with `deno desktop` into a scratch directory outside the
 * project (`deno desktop` only compiles: it opens no window, and the binary gets only the
 * permissions it is built with). The flags are the packaging scripts' (see
 * {@linkcode desktopLaunchBuildPlan}). The scratch directory is removed when the build fails.
 */
async function buildDesktopWindow(
  dir: string,
  entry: string,
  launch: DesktopWindowLaunch,
  opts: { dev: boolean; netHosts?: string[] },
): Promise<BuiltDesktopWindow> {
  const os = hostDesktopOs();
  const scratch = await desktopLaunchScratchDir(dir);
  try {
    const plan = await desktopLaunchBuildPlan({
      projectDir: dir,
      config: launch.config,
      os,
      denoFlags: launch.denoFlags,
      entry,
      dev: opts.dev,
      netHosts: opts.netHosts,
      scratch,
    });
    console.log(`  Building the desktop app (deno desktop) into ${scratch}…\n`);
    const { code } = await new Deno.Command(denoExecutable(), {
      args: plan.args,
      cwd: dir,
      env: launch.buildEnv,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (code !== 0) throw new Error(`deno desktop exited with code ${code}`);
    return { exe: await desktopLaunchExecutable(os, plan.bundle), scratch };
  } catch (err) {
    await removeScratch(scratch);
    throw err;
  }
}

/** Remove a scratch build directory (best effort). */
async function removeScratch(scratch: string): Promise<void> {
  await Deno.remove(scratch, { recursive: true }).catch(() => {});
}

/**
 * Launch a built window's executable directly (so its stdout/stderr stream to this terminal), with
 * the launch env on top of this process's. `stop` ends it; `finished` resolves to its exit code.
 */
function launchDesktopWindow(
  built: BuiltDesktopWindow,
  dir: string,
  env: Record<string, string>,
): DesktopWindow & { readonly code: Promise<number> } {
  const child = new Deno.Command(built.exe, {
    cwd: dir,
    env,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const code = child.status.then((s) => s.code);
  return {
    code,
    finished: code.then(() => {}),
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      await child.status;
      await removeScratch(built.scratch);
    },
  };
}

/**
 * `denext desktop dev [dir]`: live reload against `denext dev`. Requires the desktop entry, then
 * starts (or attaches to) the dev server on a loopback target (a non-loopback one needs `--lan`),
 * builds the app from a generated entry that marks it a dev build (see `desktop-launch.ts`) and
 * opens the window in proxy mode.
 */
async function runDesktopDevSession(
  ctx: CommandContext,
  dir: string,
  entry: string,
): Promise<void> {
  const entryPath = join(dir, entry);
  try {
    await Deno.stat(entryPath);
  } catch {
    fail(
      `denext: no desktop entry at ${entryPath}\n` +
        "  Scaffold one with `denext create --desktop`, or pass --entry <file>.",
    );
  }
  let target: { host: string; url: string };
  try {
    target = desktopDevTarget({
      lan: ctx.flags.lan === true,
      host: typeof ctx.flags.host === "string" ? ctx.flags.host : undefined,
      port: typeof ctx.flags.port === "number" ? ctx.flags.port : 3000,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  let launch: DesktopWindowLaunch;
  try {
    launch = await prepareDesktopWindow(dir, true);
  } catch (err) {
    fail(`denext desktop dev: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lan = ctx.flags.lan === true;
  try {
    await runDesktopDev({
      startServer: () => startOrAttachDevServer(dir, target.host, target.url),
      spawnWindow: async (devUrl) => {
        const devEntry = await writeDesktopDevEntry(dir, launch.buildDir, entry);
        const built = await buildDesktopWindow(dir, devEntry, launch, {
          dev: true,
          // The window's runtime reaches a LAN dev server over the network.
          netHosts: lan ? [new URL(devUrl).hostname] : [],
        });
        return launchDesktopWindow(built, dir, {
          ...launch.env,
          [DESKTOP_DEV_URL_ENV]: devUrl,
          ...(lan ? { [DESKTOP_DEV_LAN_ENV]: "1" } : {}),
        });
      },
      waitForStop: waitForShutdownSignal,
      log: (line) => console.log(line),
    });
  } catch (err) {
    fail(`denext desktop dev: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * `denext desktop run`: export the SPA, build the app into a scratch directory, open it, and stream
 * its output until it exits (Ctrl-C quits it). Exits with the app's exit code.
 */
async function runDesktop(dir: string, entry: string): Promise<void> {
  const entryPath = join(dir, entry);
  try {
    await Deno.stat(entryPath);
  } catch {
    console.error(
      `denext: no desktop entry at ${entryPath}\n` +
        "  Scaffold one with `denext create --desktop`, or pass --entry <file>.",
    );
    Deno.exit(1);
  }
  let launch: DesktopWindowLaunch;
  try {
    launch = await prepareDesktopWindow(dir);
  } catch (err) {
    fail(`denext desktop run: ${err instanceof Error ? err.message : String(err)}`);
  }
  await exportSpa(dir);
  let built: BuiltDesktopWindow;
  try {
    built = await buildDesktopWindow(dir, entry, launch, { dev: false });
  } catch (err) {
    fail(`denext desktop run: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`  Opening the desktop window  ▸  ${built.exe}\n  Ctrl-C quits the app.\n`);
  const stopped = waitForShutdownSignal();
  const window = launchDesktopWindow(built, dir, launch.env);
  const quit = await Promise.race([stopped.then(() => true), window.finished.then(() => false)]);
  await window.stop();
  // Quit from here (Ctrl-C) is a clean exit; otherwise the app's own exit code.
  Deno.exit(quit ? 0 : await window.code);
}

/** `denext desktop package`: run the scaffolded packaging script for the target OS (or, with
 * `--regenerate-scripts`, rewrite the scripts from the current template instead of running one). */
async function packageDesktop(ctx: CommandContext, dir: string): Promise<void> {
  if (ctx.flags["regenerate-scripts"] === true) return await regeneratePackageScripts(dir);
  const targetOs = packageTargetOs(ctx);
  const script = join(dir, "scripts", PACKAGE_SCRIPTS[targetOs]);
  let scriptText: string;
  try {
    scriptText = await Deno.readTextFile(script);
  } catch {
    console.error(
      `denext: no packaging script at ${script}\n` +
        "  Scaffold desktop packaging with `denext create --desktop`, or write the scripts with\n" +
        "  `denext desktop package --regenerate-scripts`.",
    );
    Deno.exit(1);
  }
  console.log(`\n  denext desktop — packaging (${targetOs})  ▸  ${dir}\n`);
  // The script reads `desktop.denoFlags` itself; check them (and hint at a pnpm workspace) first.
  try {
    await projectDenoFlags(dir, (await resolveProject(dir)).config);
  } catch (err) {
    fail(`denext desktop package: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The `denext` CLI re-execs itself once to load lightningcss / the project config, setting
  // DENEXT_CSS_ACTIVE / DENEXT_MODULE_ACTIVE as a loop guard (cli.ts). Those must NOT leak into the
  // packaging script's own `deno task export` child: it would see the guard, skip its own CSS
  // re-exec, and fail with `Import "denext/desktop/client" not a dependency` for any project with a
  // stylesheet (the default scaffold has public/styles.css). Deno.Command inherits the parent env,
  // so clear the guards here before spawning.
  Deno.env.delete("DENEXT_CSS_ACTIVE");
  Deno.env.delete("DENEXT_MODULE_ACTIVE");
  const format = ctx.flags.format as string | undefined;
  const age = packageScriptAge(scriptText);
  for (const line of packageScriptWarnings(PACKAGE_SCRIPTS[targetOs], age, format)) {
    console.error(line);
  }
  const formatArgs = format && age.formats ? ["--format", format] : [];
  await spawnDenoAndExit(["run", "-A", script, ...formatArgs, ...ctx.rest], dir);
}

/** What a packaging script predating denext 3.1 lacks. */
export interface PackageScriptAge {
  /** It builds on denext's pinned runtime (calls `desktopRuntimeEnv` / `buildDesktopBundle`). */
  readonly runtime: boolean;
  /** It takes `--format` (parses its arguments with `parseDesktopPackageArgs`). */
  readonly formats: boolean;
}

/**
 * How current a `scripts/package-<os>.ts` is, read from its text (it is never imported here).
 *
 * @param text The script's source.
 * @returns What it supports.
 */
export function packageScriptAge(text: string): PackageScriptAge {
  return {
    runtime: /\b(desktopRuntimeEnv|buildDesktopBundle)\b/.test(text),
    formats: /\bparseDesktopPackageArgs\b/.test(text),
  };
}

/**
 * The warnings for a packaging script that predates denext 3.1: it builds on the stock runtime,
 * and a `--format` is not passed to a script that cannot read it.
 *
 * @param name The script's file name (`package-linux.ts`).
 * @param age What it supports.
 * @param format The `--format` value, when given.
 * @returns The lines to print (none for a current script).
 */
export function packageScriptWarnings(
  name: string,
  age: PackageScriptAge,
  format: string | undefined,
): string[] {
  const out: string[] = [];
  if (!age.runtime) {
    out.push(
      `  ⚠ scripts/${name} predates denext 3.1: it builds with the stock Deno Desktop runtime ` +
        "and none of the default installers.\n" +
        "    Run `denext desktop package --regenerate-scripts` to adopt the current template " +
        "(the old file is kept as a .bak).",
    );
  }
  if (format && !age.formats) {
    out.push(
      `  ⚠ --format ${format} is ignored: scripts/${name} does not take --format. Regenerate it ` +
        "with `denext desktop package --regenerate-scripts`.",
    );
  }
  return out;
}

/** Whether `path` is itself a symbolic link (a missing path is not). */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isSymlink;
  } catch {
    return false;
  }
}

/**
 * `denext desktop package --regenerate-scripts`: rewrite `scripts/package-{macos,linux,windows}.ts`
 * from the CURRENT scaffold template (so an existing project adopts the least-privilege `deno desktop`
 * flags in place of a stale `-A` script). Never a silent overwrite: a file that already exists and
 * differs is backed up to `<name>.bak` and the change is printed as a unified diff; an identical file
 * is left alone; a missing one is created. Opt-in only (this runs solely under the flag).
 */
async function regeneratePackageScripts(dir: string): Promise<void> {
  const scripts = scaffoldFiles({ dir, desktop: true }).filter((f) =>
    f.path.startsWith("scripts/package-") && f.path.endsWith(".ts")
  );
  console.log(`\n  denext desktop — regenerating packaging scripts  ▸  ${dir}\n`);
  let changed = 0;
  for (const f of scripts) {
    const dest = join(dir, f.path);
    let existing: string | undefined;
    try {
      existing = await Deno.readTextFile(dest);
    } catch {
      existing = undefined; // not present yet
    }
    if (existing === f.content) {
      console.log(`  unchanged  ${f.path}`);
      continue;
    }
    await Deno.mkdir(dirname(dest), { recursive: true });
    // Never write THROUGH a symlink: a cloned repo could point a script (or its .bak) at a file
    // outside the project (~/.zshrc) and have this command write repo-controlled content there.
    if (await isSymlink(dest)) {
      console.error(`  skipped    ${f.path}  (a symlink; replace it with a regular file first)`);
      continue;
    }
    if (existing === undefined) {
      await Deno.writeTextFile(dest, f.content, { createNew: true });
      console.log(`  created    ${f.path}`);
    } else {
      const bak = `${dest}.bak`;
      // Replace (not write through) any existing .bak — removing a symlink removes the link only.
      await Deno.remove(bak).catch((err) => {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      });
      await Deno.writeTextFile(bak, existing, { createNew: true });
      await Deno.writeTextFile(dest, f.content);
      console.log(`  updated    ${f.path}  (previous saved to ${f.path}.bak)`);
      const diff = createUnifiedDiff(existing, f.content, `a/${f.path}`, `b/${f.path}`);
      if (diff) console.log(diff.trimEnd() + "\n");
    }
    changed++;
  }
  console.log(
    changed === 0
      ? "\n  Already up to date.\n"
      : `\n  Regenerated ${changed} script(s). Review the diff, then commit. The scripts now derive\n` +
        "  --allow-* from your desktop.capabilities instead of -A.\n",
  );
  await warnIfUpdaterMissingNet(dir);
}

/**
 * Warn (not fail) when `desktop.ts` uses the self-updater but `desktop.extraPermissions.net` has no
 * feed host: the derived scripts only grant loopback net, so the updater — which fetches from its
 * feed host and writes its data dir — would silently never update. The updater config lives in
 * `desktop.ts` code (not `denext.config.ts`), so it can't be auto-derived; this points the developer
 * at the escape hatch. A static text scan, deliberately: it must not import/run the project.
 */
async function warnIfUpdaterMissingNet(dir: string): Promise<void> {
  const entry = await Deno.readTextFile(join(dir, "desktop.ts")).catch(() => "");
  if (!(/runDesktop\s*\(/.test(entry) && /\bupdater\b/.test(entry))) return;
  const config = await Deno.readTextFile(join(dir, "denext.config.ts")).catch(() => "");
  if (/extraPermissions\s*:\s*\{[\s\S]*?\bnet\b/.test(config)) return;
  console.error(
    "  ⚠ desktop.ts uses the self-updater, but the derived scripts grant only loopback net.\n" +
      "    The updater fetches from its feed host and writes its data dir, so add them to\n" +
      "    denext.config.ts:\n" +
      '        desktop: { extraPermissions: { net: ["updates.example.com"], write: ["."] } }\n' +
      "    or the packaged app will silently fail to update.\n",
  );
}

type PackageOs = "macos" | "linux" | "windows";

/** The scaffolded packaging script per OS. */
const PACKAGE_SCRIPTS: Record<PackageOs, string> = {
  macos: "package-macos.ts",
  linux: "package-linux.ts",
  windows: "package-windows.ts",
};

/**
 * Which OS to package for: an explicit --target-os, else the host. macOS packaging
 * (codesign/notarize) must run on macOS; Linux bundles cross-build from any OS; the
 * Windows `.exe` cross-builds from any OS too (Authenticode signing only runs when a
 * cert is provided and signtool exists, so no host guard like macOS's).
 */
function packageTargetOs(ctx: CommandContext): PackageOs {
  const hostOs = Deno.build.os === "darwin" ? "macos" : Deno.build.os;
  const targetOs = ((ctx.flags["target-os"] as string | undefined) ?? hostOs)
    .toLowerCase();
  if (targetOs === "macos" && Deno.build.os !== "darwin") {
    console.error(
      `denext: macOS packaging must run on macOS (it shells out to codesign/notarytool); this is ${Deno.build.os}.\n` +
        "  Build a Linux bundle here with `denext desktop package --target-os linux`, or run unpackaged with `denext desktop run`.",
    );
    Deno.exit(1);
  }
  if (!(targetOs in PACKAGE_SCRIPTS)) {
    console.error(
      `denext: desktop packaging supports macos | linux | windows (got "${targetOs}").\n` +
        "  Run unpackaged with `denext desktop run`.",
    );
    Deno.exit(1);
  }
  return targetOs as PackageOs;
}
