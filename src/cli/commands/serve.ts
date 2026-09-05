// The module-loading verbs: `dev`, `build`, `export`, `start`, `probe`. Each loads
// the user's app, so all declare `loadsModules: true` (the CLI entrypoint runs the
// `.env` + CSS/module re-exec gate before dispatching them). Logic lives in
// `src/build/*` / `src/testing/*`; these specs only orchestrate.

import type { CommandContext, CommandSpec } from "../command.ts";
import { envGet } from "../../runtime/env-safe.ts";
import { ensureAppDir, installShutdown, projectDir, runBuildStep } from "../shared.ts";
import { type ProjectPaths, resolveProject } from "../../build/paths.ts";
import { startDevServer } from "../../build/dev-server.ts";
import { startProdServer } from "../../build/prod-server.ts";
import { build } from "../../build/build.ts";
import { staticExport } from "../../build/export.ts";

/** `--port`/`--host` shared by the two serving verbs. */
const SERVE_FLAGS = [
  {
    name: "port",
    alias: "p",
    type: "number",
    valueName: "<port>",
    help: "Port (default: 3000)",
  },
  {
    name: "host",
    altNames: ["hostname"],
    type: "string",
    valueName: "<host>",
    help: "Hostname",
  },
] as const;

/**
 * The port to listen on: `--port`, else the `$PORT` environment variable (what every PaaS —
 * Heroku, Cloud Run, Fly, Railway — injects), else undefined so the server auto-selects.
 */
function portOf(ctx: CommandContext): number | undefined {
  if (typeof ctx.flags.port === "number") return ctx.flags.port;
  const env = Number(envGet("PORT"));
  return Number.isInteger(env) && env > 0 && env < 65536 ? env : undefined;
}

/**
 * Resolve the project a command operates on. SPA mode has no `app/` directory — skip the
 * app-dir gate there.
 */
async function appProject(ctx: CommandContext): Promise<{ dir: string; paths: ProjectPaths }> {
  const dir = projectDir(ctx);
  const paths = await resolveProject(dir);
  if (paths.config?.mode !== "spa") await ensureAppDir(paths.appDir, paths.projectDir);
  return { dir, paths };
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
    const { paths } = await appProject(ctx);
    const controller = new AbortController();
    installShutdown(controller);
    const port = portOf(ctx);
    startDevServer({
      paths,
      port: port ?? 3000,
      hostname: ctx.flags.host as string | undefined,
      strictPort: port !== undefined,
      signal: controller.signal,
      // The real dev CLI owns this process (one dev server), so it can safely capture the
      // process console into the dev black box (readable via the `denext mcp` live tools).
      // Opt out with DENEXT_DEV_CAPTURE_CONSOLE=0 — the buffer is local-readable, so anyone
      // who logs secrets in dev may prefer to keep console out of it.
      captureServerConsole: Deno.env.get("DENEXT_DEV_CAPTURE_CONSOLE") !== "0",
    });
  },
};

export const buildCommand: CommandSpec = {
  name: "build",
  summary: "Build for production",
  loadsModules: true,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    const { dir } = await appProject(ctx);
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
    const { dir } = await appProject(ctx);
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

/**
 * `denext start` IS the production signal: when the deploy set neither `NODE_ENV` nor
 * `DENEXT_ENV`, set `DENEXT_ENV=production` so every "refuse in production" guard
 * (weak session secret, missing `canonicalOrigin`) actually fires under a plain
 * `deno task start`. A read-only env sandbox (`--allow-env=PORT`) leaves it unset.
 */
function markProduction(): void {
  try {
    if (!Deno.env.get("NODE_ENV") && !Deno.env.get("DENEXT_ENV")) {
      Deno.env.set("DENEXT_ENV", "production");
    }
  } catch {
    // no env write permission — the deployer opted out of the signal
  }
}

export const startCommand: CommandSpec = {
  name: "start",
  summary: "Serve a production build",
  loadsModules: true,
  flags: SERVE_FLAGS,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    markProduction();
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
