#!/usr/bin/env -S deno run -A
/**
 * The denext command-line interface.
 *
 * Run it directly (`deno run -A jsr:@denext/denext/cli dev .`), install it as a
 * global command (`deno install -A -g -n denext jsr:@denext/denext/cli`), or
 * compile a standalone binary (`deno compile -A --output denext cli.ts`).
 *
 * This entrypoint owns argv, `.env` loading, and the CSS/module re-exec (which is
 * intrinsic to the CLI's own module URL); the command framework
 * (`src/cli/command.ts`) owns parsing, help, suggestions, and dispatch, and each
 * verb lives in `src/cli/commands/*.ts`.
 *
 * @module
 */

import { fromFileUrl, join } from "@std/path";
import { resolveProject } from "./src/build/paths.ts";
import { buildAppCss } from "./src/build/css.ts";
import { tailwindPaths } from "./src/build/tailwind.ts";
import { denoExecutable, frameworkRoot } from "./src/build/bundle.ts";
import {
  configAnchorsResolution,
  readConfig,
  writeMergedModuleConfig,
} from "./src/build/module-config.ts";
import { loadEnv } from "./src/server/env.ts";
import { VERSION } from "./mod.ts";
import type { CommandContext, CommandSpec } from "./src/cli/command.ts";
import { buildRegistry } from "./src/cli/register.ts";
import { projectDir, SHUTDOWN_SIGNALS } from "./src/cli/shared.ts";

/**
 * The `--allow-*` flags to give a re-exec child: mirror the parent's coarse
 * permission grants (a parent run with `-A` grants all → all pass through; a scoped
 * parent passes through only what it holds). Path-scoped grants can't be enumerated
 * by the Deno API, so they aren't reconstructed.
 */
async function childPermissionFlags(): Promise<string[]> {
  const names: Deno.PermissionName[] = ["read", "write", "net", "env", "run", "sys", "ffi"];
  const flags: string[] = [];
  for (const name of names) {
    try {
      if ((await Deno.permissions.query({ name })).state === "granted") {
        flags.push(`--allow-${name}`);
      }
    } catch { /* permission name unknown to this Deno version */ }
  }
  return flags;
}

/**
 * Deno cannot `import()` a `.css` module and offers no runtime loader hook, so when
 * a project uses CSS we generate a merged deno config (redirecting each `.css` to a
 * JS shim) and re-exec the CLI with `--config` so the module loader can resolve
 * those imports. A guard env var stops infinite re-exec. Returns `true` if it
 * re-exec'd (the caller should stop).
 */
async function maybeReexecForCss(dir: string, minify: boolean): Promise<boolean> {
  if (Deno.env.get("DENEXT_CSS_ACTIVE")) return false;
  const paths = await resolveProject(dir);
  const css = await buildAppCss({
    projectDir: dir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify,
    tailwind: tailwindPaths(dir, paths.config?.tailwind),
  });
  if (!css) return false; // no CSS in the project — run normally

  if (!import.meta.url.startsWith("file://")) {
    // A compiled binary cannot re-exec itself to apply the CSS import map, so
    // `.css` imports would fail at runtime. Warn loudly rather than fail silently.
    console.error(
      "denext: WARNING — this project imports CSS, but a compiled binary cannot " +
        'apply the CSS import map. `import "./x.css"` will fail at runtime; run via ' +
        "`deno run -A jsr:@denext/denext/cli` for CSS support.",
    );
    return false;
  }
  return await reexecWithConfig(css.configPath, "DENEXT_CSS_ACTIVE");
}

/**
 * Re-exec this CLI with `--config configPath` and `activeEnv=1` set (the guard the
 * parent checks to avoid re-exec loops), forwarding stdio + shutdown signals, then
 * exit with the child's code. Never returns.
 *
 * Propagates the parent's actual permission grants instead of a blanket `-A`, so an
 * operator who scoped a command down doesn't get full permissions silently restored
 * by the re-exec. Coarse grants only — Deno exposes no way to enumerate path-scoped
 * grants.
 */
async function reexecWithConfig(configPath: string, activeEnv: string): Promise<never> {
  const child = new Deno.Command(denoExecutable(), {
    args: [
      "run",
      // sloppy-imports so the re-exec'd process can load Next.js app route modules
      // that use extensionless imports at runtime (permissive fallback).
      "--unstable-sloppy-imports",
      ...await childPermissionFlags(),
      "--config",
      configPath,
      fromFileUrl(import.meta.url),
      ...Deno.args,
    ],
    env: { [activeEnv]: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const forward = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* already exited */ }
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, forward);
    } catch { /* unsupported */ }
  }
  const { code } = await child.status;
  Deno.exit(code);
}

/**
 * Re-exec module commands with a merged framework+app config when the project has
 * its own `deno.json` that anchors module resolution to itself — a manual
 * `node_modules` or a `npm:` import (server-side npm deps like an ORM driver).
 *
 * Deno resolves a locally-run `cli.ts`'s imports against the framework's config, so
 * a bare `import "drizzle-orm"` in an app's server module would otherwise be "not a
 * dependency and not in import map". (A `jsr:`/compiled CLI already discovers the
 * app's config from the CWD, so this is a source-checkout/monorepo fix — hence the
 * `file://` guard.) CSS-using projects are handled by {@linkcode maybeReexecForCss}.
 */
async function maybeReexecForModules(dir: string): Promise<boolean> {
  if (Deno.env.get("DENEXT_MODULE_ACTIVE") || Deno.env.get("DENEXT_CSS_ACTIVE")) return false;
  if (!import.meta.url.startsWith("file://")) return false;
  const paths = await resolveProject(dir);
  if (paths.configPath === join(frameworkRoot(), "deno.json")) return false;
  if (!configAnchorsResolution(await readConfig(paths.configPath))) return false;
  const configPath = await writeMergedModuleConfig(
    paths.outDir,
    paths.configPath,
    join(frameworkRoot(), "deno.json"),
  );
  return await reexecWithConfig(configPath, "DENEXT_MODULE_ACTIVE");
}

/**
 * For a module-loading verb, load `.env` then apply the CSS/module re-exec gate.
 * Returns `true` if the process re-exec'd (the caller should stop). A no-op for
 * verbs that don't load user modules.
 */
async function moduleGate(command: CommandSpec, ctx: CommandContext): Promise<boolean> {
  if (!command.loadsModules) return false;
  const dir = command.moduleDir ? command.moduleDir(ctx) : projectDir(ctx);
  await loadEnv({ dir });
  // `dev` builds unminified CSS; the other module verbs minify (matching 1.x).
  if (await maybeReexecForCss(dir, command.name !== "dev")) return true;
  if (await maybeReexecForModules(dir)) return true;
  return false;
}

async function main(): Promise<void> {
  const registry = buildRegistry();
  const outcome = registry.parse(Deno.args);

  switch (outcome.kind) {
    case "version":
      console.log(`denext ${VERSION}`);
      return;
    case "help":
      console.log(
        outcome.command
          ? registry.formatCommandHelp(outcome.command)
          : registry.formatHelp(VERSION),
      );
      return;
    case "error":
      console.error(
        `denext: ${outcome.message}` +
          (outcome.suggestion ? `\n  Did you mean \`${outcome.suggestion}\`?` : "") +
          `\n  Run \`denext --help\` for usage.`,
      );
      Deno.exit(1);
      return;
    case "run": {
      if (await moduleGate(outcome.command, outcome.ctx)) return;
      await outcome.command.run(outcome.ctx);
      return;
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Print known, expected failures cleanly (no stack trace); an unexpected error
    // still throws with its stack so real bugs stay debuggable.
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(error.message);
      Deno.exit(1);
    }
    // denext's own thrown errors (config load/validation, a failed build/export)
    // carry an already-formatted, user-facing message prefixed "denext:".
    if (error instanceof Error && error.message.startsWith("denext:")) {
      console.error(error.message);
      Deno.exit(1);
    }
    // A missing file / denied permission is a user/environment problem, not a bug.
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      console.error(`denext: ${error.message}`);
      Deno.exit(1);
    }
    throw error;
  }
}
