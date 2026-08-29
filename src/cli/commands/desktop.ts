// `denext desktop <run|build|package>` — promotes the scaffold-generated desktop
// `deno task`s to first-class verbs over the `denext/desktop` runtime.
//
//   run      export the SPA, then open it in a `deno desktop` native window
//   build    export the SPA to out/ (what the desktop window serves)
//   package  build a distributable app bundle — macOS (.app, signed/notarized) or
//            Linux (bundle → .tar.gz / AppImage); `--target-os` cross-builds. Windows
//            is tracked in KNOWN-LIMITATIONS.
//
// A single command whose first positional selects the action, since the framework
// models flat verbs; the second positional is the project dir.

import { join, resolve } from "@std/path";
import type { CommandContext, CommandSpec } from "../command.ts";
import { runBuildStep, spawnDenoAndExit } from "../shared.ts";
import { staticExport } from "../../build/export.ts";

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
    "  denext desktop package                 Build a distributable bundle (host OS: macOS or Linux)\n" +
    "  denext desktop package --target-os linux   Cross-build the Linux bundle from any OS",
  positionals: [
    { name: "action", help: "run | build | package (default: run)" },
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
  ],
  run: async (ctx) => {
    const action = ctx.positionals[0] ?? "run";
    const dir = desktopDir(ctx);
    const entry = (ctx.flags.entry as string | undefined) ?? "desktop.ts";

    switch (action) {
      case "build":
        await exportSpa(dir);
        return;

      case "run": {
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
        return;
      }

      case "package": {
        // Which OS to package for: an explicit --target-os, else the host. macOS packaging
        // (codesign/notarize) must run on macOS; Linux bundles cross-build from any OS.
        const hostOs = Deno.build.os === "darwin"
          ? "macos"
          : Deno.build.os === "linux"
          ? "linux"
          : Deno.build.os;
        const targetOs = ((ctx.flags["target-os"] as string | undefined) ?? hostOs).toLowerCase();

        if (targetOs === "macos" && Deno.build.os !== "darwin") {
          console.error(
            `denext: macOS packaging must run on macOS (it shells out to codesign/notarytool); this is ${Deno.build.os}.\n` +
              "  Build a Linux bundle here with `denext desktop package --target-os linux`, or run unpackaged with `denext desktop run`.",
          );
          Deno.exit(1);
        }
        if (targetOs !== "macos" && targetOs !== "linux") {
          console.error(
            `denext: desktop packaging supports macos | linux (got "${targetOs}").\n` +
              "  Windows packaging is not yet available; run unpackaged with `denext desktop run`.",
          );
          Deno.exit(1);
        }

        const scriptName = targetOs === "linux" ? "package-linux.ts" : "package-macos.ts";
        const script = join(dir, "scripts", scriptName);
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
        return;
      }

      default:
        console.error(
          `denext desktop: unknown action "${action}" (expected run | build | package).`,
        );
        Deno.exit(1);
    }
  },
};
