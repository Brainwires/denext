#!/usr/bin/env -S deno run -A
// denext command-line interface: dev | build | start.

import { resolve } from "@std/path";
import { startDevServer } from "./src/build/dev-server.ts";
import { startProdServer } from "./src/build/prod-server.ts";
import { build } from "./src/build/build.ts";
import { resolveProject } from "./src/build/paths.ts";
import { VERSION } from "./mod.ts";

function parseArgs(argv: string[]): {
  command: string;
  dir: string;
  port: number;
  hostname?: string;
} {
  const positional: string[] = [];
  let port = 3000;
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

  switch (command) {
    case "dev": {
      const paths = await resolveProject(dir);
      await ensureAppDir(paths.appDir);
      startDevServer({ paths, port, hostname });
      break;
    }
    case "build": {
      await ensureAppDir((await resolveProject(dir)).appDir);
      console.log(`\n  denext build  ▸  ${dir}\n`);
      await build(dir);
      break;
    }
    case "start": {
      await startProdServer({ projectDir: dir, port, hostname });
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
  denext start [dir] [--port 3000]                      Serve a production build
  denext version                                        Print the version

[dir] defaults to the current directory and must contain an app/ folder.`);
}

if (import.meta.main) {
  await main();
}
