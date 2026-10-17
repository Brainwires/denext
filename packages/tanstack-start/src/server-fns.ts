// The server functions an app declares, found before its server bundle is built: the bundle's
// `#tanstack-start-server-fn-resolver` module maps each function id to the module that runs it,
// so it must list them all before esbuild loads it. The scan compiles every source module that
// mentions one with TanStack's compiler (server environment) and keeps what it reports; the build
// then checks that it met no function the scan missed.

import { dirname, extname, join } from "@std/path";
import type { ServerFnInfo, StartToolchain } from "./toolchain.ts";

const SCRIPT = /\.[cm]?[jt]sx?$/;

/** Extensions an extensionless relative import may name (the scan's own small resolver). */
const PROBES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (entry.isFile && SCRIPT.test(entry.name)) yield path;
  }
}

async function resolveRelative(source: string, importer?: string): Promise<string | null> {
  if (!importer || !source.startsWith(".")) return null;
  const base = join(dirname(importer.split("?")[0]), source);
  for (const probe of PROBES) {
    try {
      const path = base + probe;
      if ((await Deno.stat(path)).isFile && (probe !== "" || extname(path))) {
        return await Deno.realPath(path);
      }
    } catch { /* next */ }
  }
  return null;
}

/**
 * Every server function declared under `srcDir`, keyed by id.
 *
 * @param tc TanStack's toolchain.
 * @param root The compiler root (the project's real path: ids hash paths relative to it).
 * @param srcDir The source directory to scan.
 */
export async function scanServerFns(
  tc: StartToolchain,
  root: string,
  srcDir: string,
): Promise<Record<string, ServerFnInfo>> {
  const found: Record<string, ServerFnInfo> = {};
  const compiler = tc.createCompiler({
    env: "server",
    root,
    onServerFnsById: (fns) => Object.assign(found, fns),
    getKnownServerFns: () => found,
    loadModule: async (id) => {
      const code = await Deno.readTextFile(id.split("?")[0]).catch(() => null);
      if (code !== null) compiler.ingestModule({ code, id });
    },
    resolveId: resolveRelative,
  });
  for await (const file of sourceFiles(srcDir)) {
    const code = await Deno.readTextFile(file);
    if (!/\bcreateServerFn\b|\.\s*handler\s*\(/.test(code)) continue;
    const id = await Deno.realPath(file);
    try {
      await compiler.compile({ code, id, detectedKinds: tc.detectKinds(code, "server") });
    } catch {
      // A module the scan cannot compile is the build's to report; the build re-checks.
    }
  }
  return found;
}

/** Whether the resolver (generated from `known`) lists every server function the build met. */
export function coversServerFns(
  known: Record<string, ServerFnInfo>,
  seen: Record<string, ServerFnInfo>,
): boolean {
  return Object.keys(seen).every((id) => id in known);
}
