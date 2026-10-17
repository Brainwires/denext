// The client bundle's guard, run once esbuild has built it: TanStack Start's import protection
// and denext's own server-only scan, over the modules the bundle actually reached (esbuild's
// metafile, after TanStack's compiler removed what only server code used).
//
// - **Start's import protection** (its defaults, as its Vite plugin applies them in a build): an
//   app module may not import `@tanstack/<framework>-start/server`, a `*.server.*` file, or a
//   module marked server-only (`import "@tanstack/react-start/server-only"`). The two specifiers
//   are recorded as the bundle resolves them (Start's server entry does not resolve for the
//   browser at all), the files read from the metafile.
// - **denext's server-only scan** (`findServerOnlyLeaks`): an app module the bundle ships may not
//   import a `node:` built-in, carry the `server-only` marker or use the `Deno` global. A module
//   the plugin compiled is scanned as compiled, so a server function's handler (gone from the
//   browser build) does not count.
//
// Either fails the build, naming the module and the chain of imports that reached it.

import { basename, isAbsolute, relative, resolve, SEPARATOR } from "@std/path";
import { findServerOnlyLeaks, type ServerOnlySignal } from "@denext/denext/build/next-compat";

/** The slice of an esbuild metafile the guard reads. */
export interface Metafile {
  inputs: Record<string, { imports: Array<{ path: string; original?: string }> }>;
  outputs: Record<
    string,
    { entryPoint?: string; inputs: Record<string, { bytesInOutput: number }> }
  >;
}

/** Start's default client-side rules (`getDefaultImportProtectionRules`). */
const SERVER_SPECIFIER = /^@tanstack\/(?:react|solid|vue)-start\/server$/;
const SERVER_ONLY_MARKER = /^@tanstack\/(?:react|solid|vue)-start\/server-only$/;
const SERVER_FILE = /\.server\./;

/**
 * The specifiers an app module may not import into the browser by name: Start's server entry
 * (which does not even resolve for the browser) and its server-only marker. The build resolves
 * them to an empty module and records the import (see {@link deniedImport}).
 */
export const DENIED_SPECIFIER = /^@tanstack\/(?:react|solid|vue)-start\/server(?:-only)?$/;

/** An app module's import of a {@link DENIED_SPECIFIER}, recorded while the bundle resolved. */
export interface DeniedImport {
  importer: string;
  specifier: string;
}

/**
 * The record for an import the build resolves, or `null` when it is allowed: an app module's
 * (not a package's) import of a {@link DENIED_SPECIFIER}.
 *
 * @param specifier The import as written.
 * @param importer The importing module's path.
 */
export function deniedImport(specifier: string, importer: string): DeniedImport | null {
  if (!DENIED_SPECIFIER.test(specifier) || !importer || inNodeModules(importer)) return null;
  return { importer, specifier };
}

/** One import the bundle may not make. */
export interface Violation {
  /** Why: Start's specifier, file or marker rule, or a denext server-only signal. */
  rule: string;
  /** The module that may not ship (absolute). */
  module: string;
  /** The app modules that reached it, entry first, the module last (absolute). */
  chain: string[];
}

/** A metafile path (relative to the build's working dir, or `namespace:id`) → a module id. */
function moduleId(path: string, cwd: string): string {
  // A namespace prefix is longer than a Windows drive letter.
  if (/^[a-z][\w-]+:/i.test(path) && !isAbsolute(path)) return path;
  return resolve(cwd, path);
}

const inNodeModules = (path: string) => /[\\/]node_modules[\\/]/.test(path);

/** Whether `path` is one of the app's own modules (a file under `cwd`, not a package). */
function isAppModule(path: string, cwd: string): boolean {
  return isAbsolute(path) && path.startsWith(cwd + SEPARATOR) && !inNodeModules(path);
}

/** The bundle's import graph: each module's imports and its first importer. */
function graphOf(meta: Metafile, cwd: string) {
  const imports = new Map<string, Array<{ to: string; specifier: string }>>();
  const importedBy = new Map<string, string>();
  for (const [from, input] of Object.entries(meta.inputs)) {
    const id = moduleId(from, cwd);
    const edges = input.imports.map((imp) => ({
      to: moduleId(imp.path, cwd),
      specifier: imp.original ?? imp.path,
    }));
    imports.set(id, edges);
    for (const { to } of edges) if (!importedBy.has(to)) importedBy.set(to, id);
  }
  return { imports, importedBy };
}

/** The app modules on the way from an entry to `target` (the target last). */
function chainTo(importedBy: Map<string, string>, target: string, cwd: string): string[] {
  const chain = [target];
  for (let at = importedBy.get(target); at && !chain.includes(at); at = importedBy.get(at)) {
    chain.unshift(at);
  }
  // The app's own modules: not the packages, nor the entries the plugin generates (`.denext/`).
  const generated = (m: string) => /^\.denext[\\/]/.test(relative(cwd, m));
  return chain.filter((m) => m === target || (isAppModule(m, cwd) && !generated(m)));
}

/**
 * Start's import-protection violations in a client bundle's graph.
 *
 * @param meta The client build's metafile.
 * @param cwd The build's working directory (the metafile's paths are relative to it).
 * @param denied The denied imports the build recorded while it resolved.
 */
export function importProtectionViolations(
  meta: Metafile,
  cwd: string,
  denied: readonly DeniedImport[] = [],
): Violation[] {
  const { imports, importedBy } = graphOf(meta, cwd);
  const found = new Map<string, Violation>();
  // `module` is what may not ship: a file, or (the specifier rule) the specifier itself.
  const add = (key: string, rule: string, module: string, via: string) => {
    if (found.has(key)) return;
    const chain = chainTo(importedBy, via, cwd);
    found.set(key, { rule, module, chain: via === module ? chain : [...chain, module] });
  };
  for (const { importer, specifier } of denied) {
    if (!imports.has(importer)) continue; // not in this bundle
    if (SERVER_ONLY_MARKER.test(specifier)) {
      add(importer, `is marked server-only (import "${specifier}")`, importer, importer);
    } else if (SERVER_SPECIFIER.test(specifier)) {
      add(`${importer}|${specifier}`, "Start's server runtime", specifier, importer);
    }
  }
  for (const [from, edges] of imports) {
    if (!isAppModule(from, cwd)) continue;
    for (const { to } of edges) {
      if (isAppModule(to, cwd) && SERVER_FILE.test(basename(to))) {
        add(to, "is a *.server.* file", to, from);
      }
    }
  }
  return [...found.values()];
}

/** A one-phrase reading of each denext server-only signal. */
const SIGNAL_TEXT: Record<ServerOnlySignal, string> = {
  "node-import": "imports a node: built-in",
  "server-only-marker": 'is marked server-only (import "server-only")',
  "deno-global": "uses the Deno global",
};

/**
 * denext's server-only leaks among the app modules the bundle shipped (what survived
 * tree-shaking), each read as the bundle compiled it.
 *
 * @param meta The client build's metafile.
 * @param cwd The build's working directory.
 * @param read A shipped module's source as it went into the bundle.
 */
export async function serverOnlyLeaks(
  meta: Metafile,
  cwd: string,
  read: (path: string) => Promise<string>,
): Promise<Violation[]> {
  const shipped = new Set<string>();
  for (const output of Object.values(meta.outputs)) {
    for (const [path, { bytesInOutput }] of Object.entries(output.inputs)) {
      const id = moduleId(path, cwd);
      if (bytesInOutput > 0 && isAppModule(id, cwd)) shipped.add(id);
    }
  }
  // The scan compares real paths (a symlinked checkout); report the paths the build used.
  const byReal = new Map<string, string>();
  for (const path of shipped) byReal.set(await Deno.realPath(path).catch(() => path), path);
  const { importedBy } = graphOf(meta, cwd);
  const leaks = await findServerOnlyLeaks(byReal.keys(), cwd, (real) => read(byReal.get(real)!));
  return leaks.map((leak) => {
    const module = byReal.get(leak.module) ?? leak.module;
    return {
      rule: leak.signals.map((s) => SIGNAL_TEXT[s]).join("; "),
      module,
      chain: chainTo(importedBy, module, cwd),
    };
  });
}

/**
 * The build error for a client bundle's violations, or `null` when there are none.
 *
 * @param violations What {@link importProtectionViolations} and {@link serverOnlyLeaks} found.
 * @param cwd The directory paths are shown relative to.
 */
export function formatViolations(violations: Violation[], cwd: string): string | null {
  if (violations.length === 0) return null;
  const show = (p: string) => {
    if (!isAbsolute(p)) return p; // a specifier
    const rel = relative(cwd, p);
    return rel.startsWith("..") ? p : rel.replace(/\\/g, "/");
  };
  const lines = violations.map((v) =>
    `  ${show(v.module)} — ${v.rule}\n    imported through ${v.chain.map(show).join(" → ")}`
  );
  return `@denext/tanstack-start: server-only code would ship to the browser.\n\n` +
    `${lines.join("\n")}\n\n` +
    `Every route module is bundled for the browser, with what it imports. Keep server code in a ` +
    `createServerFn handler (the browser gets an RPC stub) or a createServerOnlyFn body, give ` +
    `the browser its own implementation with createIsomorphicFn, or move the import into a ` +
    `module only server code imports.`;
}
