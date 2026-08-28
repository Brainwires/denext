// The module-loading verbs: `dev`, `build`, `export`, `start`, `probe`. Each loads
// the user's app, so all declare `loadsModules: true` (the CLI entrypoint runs the
// `.env` + CSS/module re-exec gate before dispatching them). Logic lives in
// `src/build/*` / `src/testing/*`; these specs only orchestrate.

import type { CommandContext, CommandSpec } from "../command.ts";
import { ensureAppDir, installShutdown, projectDir, runBuildStep } from "../shared.ts";
import { resolveProject } from "../../build/paths.ts";
import { startDevServer } from "../../build/dev-server.ts";
import { startProdServer } from "../../build/prod-server.ts";
import { build } from "../../build/build.ts";
import { staticExport } from "../../build/export.ts";

/** `--port`/`--host` shared by the two serving verbs. */
const SERVE_FLAGS = [
  { name: "port", alias: "p", type: "number", valueName: "<port>", help: "Port (default: 3000)" },
  { name: "host", altNames: ["hostname"], type: "string", valueName: "<host>", help: "Hostname" },
] as const;

/** Read the `--port` flag (absent → undefined, so the server auto-selects). */
function portOf(ctx: CommandContext): number | undefined {
  return typeof ctx.flags.port === "number" ? ctx.flags.port : undefined;
}

export const devCommand: CommandSpec = {
  name: "dev",
  summary: "Start the dev server",
  loadsModules: true,
  flags: SERVE_FLAGS,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  usage: "Without --port, an open port is auto-selected starting at 3000.\n" +
    "With --port, that exact port is required and the server errors if it is taken.",
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const paths = await resolveProject(dir);
    // SPA mode has no `app/` directory — skip the app-dir gate.
    if (paths.config?.mode !== "spa") await ensureAppDir(paths.appDir, paths.projectDir);
    const controller = new AbortController();
    installShutdown(controller);
    const port = portOf(ctx);
    startDevServer({
      paths,
      port: port ?? 3000,
      hostname: ctx.flags.host as string | undefined,
      strictPort: port !== undefined,
      signal: controller.signal,
    });
  },
};

export const buildCommand: CommandSpec = {
  name: "build",
  summary: "Build for production",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const paths = await resolveProject(dir);
    if (paths.config?.mode !== "spa") await ensureAppDir(paths.appDir, paths.projectDir);
    console.log(`\n  denext build  ▸  ${dir}\n`);
    await runBuildStep(() => build(dir), "build");
  },
};

export const exportCommand: CommandSpec = {
  name: "export",
  summary: "Static export (SSG) to out/",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const paths = await resolveProject(dir);
    if (paths.config?.mode !== "spa") await ensureAppDir(paths.appDir, paths.projectDir);
    console.log(`\n  denext export (static)  ▸  ${dir}\n`);
    const result = await runBuildStep(() => staticExport(dir), "export");
    console.log(
      `\n  Exported ${result.pages} page(s) to ${result.outDir}` +
        (result.skipped.length
          ? `\n  Skipped ${result.skipped.length} dynamic route(s) without generateStaticParams.`
          : ""),
    );
  },
};

export const startCommand: CommandSpec = {
  name: "start",
  summary: "Serve a production build",
  loadsModules: true,
  flags: SERVE_FLAGS,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const dir = projectDir(ctx);
    const controller = new AbortController();
    installShutdown(controller);
    const port = portOf(ctx);
    await startProdServer({
      projectDir: dir,
      port: port ?? 3000,
      hostname: ctx.flags.host as string | undefined,
      strictPort: port !== undefined,
      signal: controller.signal,
    });
  },
};
