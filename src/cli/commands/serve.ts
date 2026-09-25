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
import { applyPatchesAtBoot } from "./patch.ts";
import { lanBanner, pickLanAddress } from "../../build/dev-server/lan.ts";
import { devOriginError } from "../../server/config-validate.ts";

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
  await applyPatchesAtBoot(dir); // patches/*.patch → node_modules + the denext import map
  const paths = await resolveProject(dir);
  if (paths.config?.mode !== "spa") await ensureAppDir(paths.appDir, paths.projectDir);
  return { dir, paths };
}

/**
 * `--allowed-dev-origin` values (repeated and/or comma-separated) as a list, each checked the
 * way the `allowedDevOrigins` config key is.
 *
 * @param value The flag's value (repeats arrive joined with `,`).
 * @returns The entries, or the usage error to print.
 */
export function allowedDevOriginFlag(
  value: string | number | boolean | undefined,
): { ok: true; origins: string[] } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: true, origins: [] };
  const origins = value.split(",").map((v) => v.trim()).filter(Boolean);
  for (const origin of origins) {
    const problem = devOriginError(origin);
    if (problem) return { ok: false, error: `--allowed-dev-origin ${origin}: ${problem}` };
  }
  return { ok: true, origins };
}

/**
 * The host `denext dev` binds and what it prints on listen: `--lan` binds the machine's LAN
 * IPv4 and prints its URL plus a QR code; otherwise `--host` as given and the default banner.
 */
function devBind(
  ctx: CommandContext,
): { hostname?: string; onListen?: (info: { hostname: string; port: number }) => void } {
  const host = ctx.flags.host as string | undefined;
  if (ctx.flags.lan !== true) return { hostname: host };
  if (host !== undefined) fail("denext dev: --lan picks the address itself; drop --host.");
  const address = pickLanAddress();
  if (!address) fail("denext dev --lan: this machine has no LAN IPv4 address (is Wi-Fi on?).");
  return {
    hostname: address,
    onListen: ({ port }) => console.log(lanBanner(`http://${address}:${port}`)),
  };
}

/** Print a usage error and exit 2. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(2);
}

export const devCommand: CommandSpec = {
  name: "dev",
  summary: "Start the dev server",
  loadsModules: true,
  flags: [
    ...SERVE_FLAGS,
    {
      name: "lan",
      type: "boolean",
      help: "Bind the machine's LAN IPv4, allow it, and print its URL as a QR code",
    },
    {
      name: "allowed-dev-origin",
      type: "string",
      repeatable: true,
      valueName: "<origin>",
      help: "Also let this origin or host load the dev assets (repeatable, or comma-separated)",
    },
  ],
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  usage: "Without --port, an open port is auto-selected starting at 3000.\n" +
    "With --port, that exact port is required and the server errors if it is taken.\n" +
    "The dev assets (/_denext/*) answer only loopback hosts plus allowedDevOrigins. An\n" +
    "explicit --host allows the host it binds (0.0.0.0: this machine's addresses); --lan\n" +
    "binds the LAN IPv4 alone (not localhost), allows it and prints a QR code for a phone;\n" +
    "--allowed-dev-origin adds entries to the config's allowedDevOrigins for this run.",
  run: async (ctx) => {
    const allowed = allowedDevOriginFlag(ctx.flags["allowed-dev-origin"]);
    if (!allowed.ok) fail(`denext dev: ${allowed.error}`);
    const bind = devBind(ctx);
    const { paths } = await appProject(ctx);
    markDevelopment();
    const controller = new AbortController();
    installShutdown(controller);
    const port = portOf(ctx);
    startDevServer({
      paths,
      port: port ?? 3000,
      hostname: bind.hostname,
      onListen: bind.onListen,
      allowedDevOrigins: allowed.origins,
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
  envTier: "production",
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
  envTier: "production",
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

/** `denext dev`: npm code reads `process.env.NODE_ENV`; default it to `development`. */
function markDevelopment(): void {
  try {
    if (!Deno.env.get("NODE_ENV")) Deno.env.set("NODE_ENV", "development");
  } catch {
    // no env write permission
  }
}

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
    // npm code (and an app's own env validation — the Epic Stack's zod schema requires it)
    // reads `process.env.NODE_ENV`; Remix's start script set it via cross-env, so do we.
    if (!Deno.env.get("NODE_ENV")) {
      Deno.env.set(
        "NODE_ENV",
        Deno.env.get("DENEXT_ENV") === "development" ? "development" : "production",
      );
    }
  } catch {
    // no env write permission — the deployer opted out of the signal
  }
}

export const startCommand: CommandSpec = {
  name: "start",
  envTier: "production",
  summary: "Serve a production build",
  loadsModules: true,
  flags: SERVE_FLAGS,
  positionals: [{ name: "dir", help: "Project directory (default: .)" }],
  run: async (ctx) => {
    markProduction();
    const dir = projectDir(ctx);
    await applyPatchesAtBoot(dir);
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
