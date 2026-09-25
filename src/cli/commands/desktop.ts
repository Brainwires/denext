// `denext desktop <run|build|package>` — promotes the scaffold-generated desktop
// `deno task`s to first-class verbs over the `denext/desktop` runtime.
//
//   run      export the SPA, then open it in a `deno desktop` native window
//   build    export the SPA to out/ (what the desktop window serves)
//   dev      live reload: start (or attach to) `denext dev`, then open a window whose runtime
//            reverse-proxies EVERYTHING (HTTP + HMR) to it, so edits hot-reload in the window
//   package  build a distributable app bundle — macOS (.app, signed/notarized), Linux
//            (bundle → .tar.gz / AppImage) or Windows (.exe, Authenticode-signed when a
//            cert is supplied); `--target-os` cross-builds everything but macOS.
//
// `run`/`build`/`package` serve a static export over loopback. `dev` is the desktop half of
// dev-server attach (the Metro model): the window proxies to `denext dev` so the CSP and the dev
// origin gate stay untouched (`location.origin` is still loopback).
//
// A single command whose first positional selects the action, since the framework
// models flat verbs; the second positional is the project dir.

import { join, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runBuildStep, spawnDenoAndExit } from "../shared.ts";
import { spawnDenoChild, startOrAttachDevServer, waitForShutdownSignal } from "../dev-attach.ts";
import { staticExport } from "../../build/export.ts";
import { desktopDevTarget, type DesktopWindow, runDesktopDev } from "../../build/desktop-dev.ts";
import { DESKTOP_DEV_URL_ENV } from "../../build/desktop.ts";

/** The project dir for a `desktop <action> [dir]` invocation (positional[1]). */
function desktopDir(ctx: CommandContext): string {
  return resolve(ctx.global.cwd ?? ctx.positionals[1] ?? ".");
}

async function exportSpa(dir: string): Promise<void> {
  console.log(`\n  denext desktop — exporting SPA  ▸  ${dir}\n`);
  const result = await runBuildStep(() => staticExport(dir), "desktop export");
  console.log(`  Exported ${result.pages} page(s) to ${result.outDir}\n`);
}

export const desktopCommand: CommandSpec = {
  name: "desktop",
  summary: "Build/run/package the app as a native desktop app",
  loadsModules: true,
  moduleDir: desktopDir,
  usage: "  denext desktop run                     Export + open in a deno desktop window\n" +
    "  denext desktop build                   Export the SPA to out/\n" +
    "  denext desktop dev                     Live reload: open a window proxied to `denext dev`\n" +
    "  denext desktop dev --lan               …attach to a dev server on your network (loopback else)\n" +
    "  denext desktop package                 Build a distributable bundle (host OS: macOS or Linux)\n" +
    "  denext desktop package --target-os linux   Cross-build the Linux bundle from any OS",
  positionals: [
    { name: "action", help: "run | build | dev | package (default: run)" },
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
      help: "package for: macos | linux (default: the host OS; cross-builds where supported)",
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
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0] ?? "run";
    const dir = desktopDir(ctx);
    const entry = (ctx.flags.entry as string | undefined) ?? "desktop.ts";
    if (action === "build") return await exportSpa(dir);
    if (action === "run") return await runDesktop(dir, entry);
    if (action === "dev") return await runDesktopDevSession(ctx, dir, entry);
    if (action === "package") return await packageDesktop(ctx, dir);
    console.error(
      `denext desktop: unknown action "${action}" (expected run | build | dev | package).`,
    );
    Deno.exit(1);
  },
};

/** Print `message` to stderr and exit 1. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

/**
 * Spawn `deno desktop <entry>` with the dev-only env seam `DENEXT_DESKTOP_DEV_URL` set to the dev
 * server URL — the ONLY switch that puts the desktop runtime into proxy mode. The permission split
 * (invariant 4): the window needs net to the loopback dev port only, exactly what the baked
 * `--allow-net=127.0.0.1,localhost` already grants, so nothing is widened vs a packaged build.
 */
function spawnDesktopWindow(project: string, entry: string, devUrl: string): DesktopWindow {
  const { finished, stop } = spawnDenoChild(["desktop", entry], {
    cwd: project,
    stdin: "inherit",
    env: { [DESKTOP_DEV_URL_ENV]: devUrl },
  });
  return { finished, stop };
}

/**
 * `denext desktop dev [dir]`: live reload against `denext dev`. Requires the desktop entry, then
 * starts (or attaches to) the dev server on a loopback target (a non-loopback one needs `--lan`)
 * and opens the window in proxy mode.
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
  try {
    await runDesktopDev({
      startServer: () => startOrAttachDevServer(dir, target.host, target.url),
      spawnWindow: (devUrl) => Promise.resolve(spawnDesktopWindow(dir, entry, devUrl)),
      waitForStop: waitForShutdownSignal,
      log: (line) => console.log(line),
    });
  } catch (err) {
    fail(`denext desktop dev: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `denext desktop run`: export the SPA, then open it in a native window. */
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
  await exportSpa(dir);
  console.log("  Opening desktop window (deno desktop)…\n");
  // `deno desktop <entry>` wraps the entry's Deno.serve() in a native window;
  // needs Deno 2.9+. Replaces this process with the child.
  await spawnDenoAndExit(["desktop", entry], dir);
}

/** `denext desktop package`: run the scaffolded packaging script for the target OS. */
async function packageDesktop(ctx: CommandContext, dir: string): Promise<void> {
  const targetOs = packageTargetOs(ctx);
  const script = join(dir, "scripts", PACKAGE_SCRIPTS[targetOs]);
  try {
    await Deno.stat(script);
  } catch {
    console.error(
      `denext: no packaging script at ${script}\n` +
        "  Scaffold desktop packaging with `denext create --desktop`.",
    );
    Deno.exit(1);
  }
  console.log(`\n  denext desktop — packaging (${targetOs})  ▸  ${dir}\n`);
  await spawnDenoAndExit(["run", "-A", script, ...ctx.rest], dir);
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
