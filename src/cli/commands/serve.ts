// The module-loading verbs: `dev`, `build`, `export`, `start`, `probe`. Each loads
// the user's app, so all declare `loadsModules: true` (the CLI entrypoint runs the
// `.env` + CSS/module re-exec gate before dispatching them). Logic lives in
// `src/build/*` / `src/testing/*`; these specs only orchestrate.

import { parsePlatform, type Platform, PLATFORM_ENV } from "../../build/platform-extensions.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { markProduction, portOf } from "./start-options.ts";
import { ensureAppDir, projectDir, runBuildStep } from "../shared.ts";
import { installShutdown } from "../shutdown.ts";
import { type ProjectPaths, resolveProject } from "../../build/paths.ts";
import { canonicalPath } from "../../build/canonical-path.ts";
import { startDevServer } from "../../build/dev-server.ts";
import { startProdServer } from "../../build/prod-server.ts";
import { build } from "../../build/build.ts";
import { compileApp } from "../../build/compile-app.ts";
import { staticExport } from "../../build/export.ts";
import { deployAfterBuild } from "../../build/deploy-flow.ts";
import { applyPatchesAtBoot } from "./patch.ts";
import { lanBanner, pickLanAddress } from "../../build/dev-server/lan.ts";
import { devSessionToken, withDevTokenParam } from "../../build/dev-server/dev-token.ts";
import { devOriginError } from "../../server/config-validate.ts";
import { SOURCEMAPS_ENV } from "../../build/hidden-sourcemaps.ts";
import { abortJobRuns } from "../../server/jobs.ts";
import { markBuildPhase } from "../../server/phase.ts";
import { applyRawFlag } from "../explain-output.ts";
import { commandMeta } from "../command-meta.ts";

/**
 * Resolve the project a command operates on. SPA mode has no `app/` directory — skip the
 * app-dir gate there.
 */
async function appProject(ctx: CommandContext): Promise<{ dir: string; paths: ProjectPaths }> {
  const dir = canonicalPath(projectDir(ctx)); // the real path, as in build() (canonical-path.ts)
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
): {
  hostname?: string;
  devToken?: string;
  onListen?: (info: { hostname: string; port: number }) => void;
} {
  const host = ctx.flags.host as string | undefined;
  if (ctx.flags.lan !== true) return { hostname: host, devToken: devSessionToken(host) };
  if (host !== undefined) fail("denext dev: --lan picks the address itself; drop --host.");
  const address = pickLanAddress();
  if (!address) fail("denext dev --lan: this machine has no LAN IPv4 address (is Wi-Fi on?).");
  // A LAN bind: the printed URL (and its QR code) carries the session token.
  const devToken = devSessionToken(address);
  return {
    hostname: address,
    devToken,
    onListen: ({ port }) =>
      console.log(lanBanner(withDevTokenParam(`http://${address}:${port}`, devToken))),
  };
}

/** Print a usage error and exit 2. */
function fail(message: string): never {
  console.error(message);
  Deno.exit(2);
}

export const devCommand: CommandSpec = {
  ...commandMeta("dev"),
  run: async (ctx) => {
    applyRawFlag(ctx);
    const allowed = allowedDevOriginFlag(ctx.flags["allowed-dev-origin"]);
    if (!allowed.ok) fail(`denext dev: ${allowed.error}`);
    const bind = devBind(ctx);
    const { paths } = await appProject(ctx);
    markDevelopment();
    const controller = new AbortController();
    installShutdown(controller);
    // Shutdown aborts every job run's signal, `runJob()` calls that passed none included.
    controller.signal.addEventListener("abort", abortJobRuns, { once: true });
    const port = portOf(ctx);
    startDevServer({
      paths,
      port: port ?? 3000,
      hostname: bind.hostname,
      devToken: bind.devToken,
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
  ...commandMeta("build"),
  // `.denext/` is both the build dir and the artifact dir: one exclusive lock.
  locks: (ctx) => ({ projectDir: projectDir(ctx), buildDir: "exclusive" }),
  run: async (ctx) => {
    applyRawFlag(ctx);
    const compile = ctx.flags.compile === true;
    if (
      !compile &&
      (ctx.flags.target !== undefined || ctx.flags.output !== undefined ||
        ctx.flags.sign !== undefined)
    ) {
      fail("denext build: --target, --output and --sign go with --compile.");
    }
    markBuildPhase();
    const { dir } = await appProject(ctx);
    console.log(`\n  denext build${compile ? " --compile" : ""}  ▸  ${dir}\n`);
    await runBuildStep(() => build(dir), "build");
    const target = ctx.flags.target as string | undefined;
    const result = compile
      ? await runBuildStep(
        () =>
          compileApp(dir, {
            target,
            output: ctx.flags.output as string | undefined,
            sign: ctx.flags.sign === true,
          }),
        "compile",
      )
      : undefined;
    if (result) printCompiled(result);
    // The deploy manifest (.denext/deploy-manifest.json) and the configured adapter's prepare.
    await runBuildStep(
      () => deployAfterBuild(dir, result && { ...result, ...(target ? { target } : {}) }),
      "deploy manifest",
    );
    exitOneShot();
  },
};

/** What `build --compile` made: the executable, its permissions, signing, what it left out. */
function printCompiled(result: Awaited<ReturnType<typeof compileApp>>): void {
  console.log(`\n  Compiled ${result.output}\n  Permissions: ${result.permissions.join(" ")}`);
  if (result.signing) console.log(`  Signing: ${result.signing.detail}`);
  if (result.skipped.length > 0) {
    console.log(
      `  Not embedded (not build outputs; add to compile.include if the server reads one): ` +
        result.skipped.map((name) => `.denext/${name}`).join(", "),
    );
  }
}

/**
 * End a one-shot verb that imported the app's server modules (`build`, `export`). A client such
 * a module opens at its top level — a database pool that connects eagerly (`mariadb`), a Redis
 * connection, an interval — keeps the event loop alive, so the finished verb would never exit.
 */
function exitOneShot(): void {
  Deno.exit(0);
}

/**
 * The export's target: `--platform`, else {@linkcode PLATFORM_ENV} (what `denext desktop
 * package`'s script sets for its `deno task export` child), else `web`. Exits on a bad value.
 */
function exportPlatform(flag: unknown): Platform {
  try {
    if (typeof flag === "string") return parsePlatform(flag, "--platform");
    return parsePlatform(Deno.env.get(PLATFORM_ENV), PLATFORM_ENV);
  } catch (err) {
    console.error(`denext export: ${(err as Error).message}`);
    Deno.exit(1);
  }
}

export const exportCommand: CommandSpec = {
  ...commandMeta("export"),
  locks: (ctx) => ({ projectDir: projectDir(ctx), buildDir: "exclusive", outputDirs: ["out"] }),
  run: async (ctx) => {
    const sourcemaps = ctx.flags.sourcemaps;
    if (sourcemaps !== undefined && sourcemaps !== "hidden") {
      console.error(
        `denext export: --sourcemaps takes "hidden" (got ${JSON.stringify(sourcemaps)}).`,
      );
      Deno.exit(1);
    }
    if (sourcemaps === "hidden") Deno.env.set(SOURCEMAPS_ENV, "hidden");
    markBuildPhase();
    const platform = exportPlatform(ctx.flags.platform);
    const { dir } = await appProject(ctx);
    console.log(
      `\n  denext export (static)${platform === "web" ? "" : ` [${platform}]`}  ▸  ${dir}\n`,
    );
    const result = await runBuildStep(() => staticExport(dir, { platform }), "export");
    console.log(
      `\n  Exported ${result.pages} page(s) to ${result.outDir}` +
        (result.skipped.length
          ? `\n  Skipped ${result.skipped.length} dynamic route(s) without generateStaticParams.`
          : ""),
    );
    exitOneShot();
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

export const startCommand: CommandSpec = {
  ...commandMeta("start"),
  run: async (ctx) => {
    markProduction();
    const dir = projectDir(ctx);
    await applyPatchesAtBoot(dir);
    const controller = new AbortController();
    installShutdown(controller);
    // Shutdown aborts every job run's signal, `runJob()` calls that passed none included.
    controller.signal.addEventListener("abort", abortJobRuns, { once: true });
    const port = portOf(ctx);
    await startProdServer({
      projectDir: dir,
      port: port ?? 3000,
      hostname: ctx.flags.host as string | undefined,
      strictPort: port !== undefined,
      signal: controller.signal,
      exitAfterShutdown: true, // this process is the server's
    });
  },
};
