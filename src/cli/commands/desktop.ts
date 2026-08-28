// `denext desktop <run|build|package>` — promotes the scaffold-generated desktop
// `deno task`s to first-class verbs over the `denext/desktop` runtime.
//
//   run      export the SPA, then open it in a `deno desktop` native window
//   build    export the SPA to out/ (what the desktop window serves)
//   package  build a distributable app bundle (macOS today; other OSes documented
//            as a post-2.0 reach item in KNOWN-LIMITATIONS)
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
  usage: "  denext desktop run       Export + open in a deno desktop window\n" +
    "  denext desktop build     Export the SPA to out/\n" +
    "  denext desktop package   Build a distributable bundle (macOS today)",
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
        if (Deno.build.os !== "darwin") {
          console.error(
            `denext: desktop packaging currently supports macOS only (this is ${Deno.build.os}).\n` +
              "  Linux (AppImage) and Windows packaging are tracked as a post-2.0 item.\n" +
              "  On any OS you can run the app unpackaged with `denext desktop run`.",
          );
          Deno.exit(1);
        }
        const script = join(dir, "scripts", "package-macos.ts");
        try {
          await Deno.stat(script);
        } catch {
          console.error(
            `denext: no packaging script at ${script}\n` +
              "  Scaffold desktop packaging with `denext create --desktop`.",
          );
          Deno.exit(1);
        }
        console.log(`\n  denext desktop — packaging (macOS)  ▸  ${dir}\n`);
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
