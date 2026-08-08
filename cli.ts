#!/usr/bin/env -S deno run -A
/**
 * The denext command-line interface: `dev`, `build`, `start`, and `version`.
 *
 * Run it directly (`deno run -A jsr:@denext/denext/cli dev .`), install it as a
 * global command (`deno install -A -g -n denext jsr:@denext/denext/cli`), or
 * compile a standalone binary (`deno compile -A --output denext cli.ts`).
 *
 * @module
 */

import { fromFileUrl, resolve } from "@std/path";
import { startDevServer } from "./src/build/dev-server.ts";
import { startProdServer } from "./src/build/prod-server.ts";
import { build } from "./src/build/build.ts";
import { staticExport } from "./src/build/export.ts";
import { resolveProject } from "./src/build/paths.ts";
import { buildAppCss } from "./src/build/css.ts";
import { denoExecutable } from "./src/build/bundle.ts";
import { loadEnv } from "./src/server/env.ts";
import { VERSION } from "./mod.ts";

/** Commands that load user modules and therefore need the CSS import map. */
const MODULE_COMMANDS = new Set(["dev", "build", "export", "start"]);

/** Termination signals to trap for graceful shutdown (platform-dependent). */
const SHUTDOWN_SIGNALS: Deno.Signal[] = Deno.build.os === "windows"
  ? ["SIGINT", "SIGBREAK"]
  : ["SIGINT", "SIGTERM"];

/**
 * Abort `controller` on the first termination signal (and stop trapping, so the
 * process exits once the server drains). Passing the controller's signal to the
 * server makes Deno.serve stop accepting and wait for in-flight requests.
 */
function installShutdown(controller: AbortController): void {
  const onSignal = () => {
    controller.abort();
    for (const sig of SHUTDOWN_SIGNALS) {
      try {
        Deno.removeSignalListener(sig, onSignal);
      } catch { /* not installed */ }
    }
  };
  for (const sig of SHUTDOWN_SIGNALS) {
    try {
      Deno.addSignalListener(sig, onSignal);
    } catch { /* signal unsupported on this platform */ }
  }
}

/**
 * Deno cannot `import()` a `.css` module and offers no runtime loader hook, so
 * when a project uses CSS we generate a merged deno config (redirecting each
 * `.css` to a JS shim) and re-exec the CLI with `--config` so the module loader
 * can resolve those imports. A guard env var stops infinite re-exec. Returns
 * `true` if it re-exec'd (the caller should stop).
 */
async function maybeReexecForCss(command: string, dir: string): Promise<boolean> {
  if (!MODULE_COMMANDS.has(command)) return false;
  if (Deno.env.get("DENEXT_CSS_ACTIVE")) return false;
  const paths = await resolveProject(dir);
  const css = await buildAppCss({
    projectDir: dir,
    configPath: paths.configPath,
    outDir: paths.outDir,
    minify: command !== "dev",
  });
  if (!css) return false; // no CSS in the project — run normally

  const self = import.meta.url;
  if (!self.startsWith("file://")) {
    // A compiled binary cannot re-exec itself to apply the CSS import map, so
    // `.css` imports would fail at runtime. Warn loudly rather than fail silently.
    console.error(
      "denext: WARNING — this project imports CSS, but a compiled binary cannot " +
        'apply the CSS import map. `import "./x.css"` will fail at runtime; run via ' +
        "`deno run -A jsr:@denext/denext/cli` for CSS support.",
    );
    return false;
  }

  const child = new Deno.Command(denoExecutable(), {
    args: ["run", "-A", "--config", css.configPath, fromFileUrl(self), ...Deno.args],
    env: { DENEXT_CSS_ACTIVE: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  // Forward termination signals so the child server drains before exiting.
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

function parseArgs(argv: string[]): {
  command: string;
  dir: string;
  port?: number;
  hostname?: string;
} {
  const positional: string[] = [];
  let port: number | undefined;
  let hostname: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") {
      port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--host" || arg === "--hostname") {
      hostname = argv[++i];
    } else if (arg.startsWith("--host=")) {
      hostname = arg.slice("--host=".length);
    } else {
      positional.push(arg);
    }
  }
  const command = positional[0] ?? "help";
  const dir = resolve(positional[1] ?? ".");
  return { command, dir, port, hostname };
}

async function main(): Promise<void> {
  const { command, dir, port, hostname } = parseArgs(Deno.args);
  // An explicit --port is a hard requirement; an unspecified port auto-selects
  // (starting from 3000) if the default is taken.
  const strictPort = port !== undefined;
  const effectivePort = port ?? 3000;

  // Load .env / .env.local from the project directory into the environment
  // before serving, building, or exporting, so server code sees them and the
  // public-prefixed subset can reach the client.
  if (command === "dev" || command === "build" || command === "export" || command === "start") {
    await loadEnv({ dir });
    // Re-exec with a CSS import map when the project uses CSS (Deno can't import
    // `.css` directly). No-op for CSS-free projects and inside the child process.
    if (await maybeReexecForCss(command, dir)) return;
  }

  switch (command) {
    case "dev": {
      const paths = await resolveProject(dir);
      await ensureAppDir(paths.appDir);
      const controller = new AbortController();
      installShutdown(controller);
      startDevServer({
        paths,
        port: effectivePort,
        hostname,
        strictPort,
        signal: controller.signal,
      });
      break;
    }
    case "build": {
      await ensureAppDir((await resolveProject(dir)).appDir);
      console.log(`\n  denext build  ▸  ${dir}\n`);
      await build(dir);
      break;
    }
    case "export": {
      await ensureAppDir((await resolveProject(dir)).appDir);
      console.log(`\n  denext export (static)  ▸  ${dir}\n`);
      const result = await staticExport(dir);
      console.log(
        `\n  Exported ${result.pages} page(s) to ${result.outDir}` +
          (result.skipped.length
            ? `\n  Skipped ${result.skipped.length} dynamic route(s) without generateStaticParams.`
            : ""),
      );
      break;
    }
    case "start": {
      const controller = new AbortController();
      installShutdown(controller);
      await startProdServer({
        projectDir: dir,
        port: effectivePort,
        hostname,
        strictPort,
        signal: controller.signal,
      });
      break;
    }
    case "version":
    case "--version":
    case "-v":
      console.log(`denext ${VERSION}`);
      break;
    default:
      printHelp();
  }
}

async function ensureAppDir(appDir: string): Promise<void> {
  try {
    const info = await Deno.stat(appDir);
    if (!info.isDirectory) throw new Error();
  } catch {
    console.error(
      `denext: no app directory found at ${appDir}\n` +
        `Create an app/ folder with a page.tsx to get started.`,
    );
    Deno.exit(1);
  }
}

function printHelp(): void {
  console.log(`denext ${VERSION} — a Next.js-style framework for Deno

Usage:
  denext dev   [dir] [--port 3000] [--host localhost]   Start the dev server
  denext build [dir]                                    Build for production
  denext export [dir]                                   Static export (SSG) to out/
  denext start [dir] [--port 3000]                      Serve a production build
  denext version                                        Print the version

[dir] defaults to the current directory and must contain an app/ folder.
Without --port, the server auto-selects an open port starting at 3000.
With --port, that exact port is required and the server errors if it is taken.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Print known, expected failures cleanly (no stack trace).
    if (error instanceof Deno.errors.AddrInUse) {
      console.error(error.message);
      Deno.exit(1);
    }
    throw error;
  }
}
