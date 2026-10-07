// The import map a client bundle resolves the app's modules through: the target's platform
// files, the client transforms, and an action stub for every `"use server"` module.
//
// `deno bundle` resolves an app module's bare specifiers (`@/app/actions.ts`, `#actions`) with
// the app's own `deno.json` and maps the result no further, so a file-URL redirect is reached
// only by a specifier that is already a URL (a relative import). Platform files and action
// stubs therefore share one rule: each is a redirect keyed by the file URL it replaces, and every
// app module that names a redirected module through an alias — directly, through a re-export or
// a barrel, or through another such module — is copied with those imports rewritten to the
// redirect's target ({@linkcode platformImportMap}, which resolves each import by
// {@linkcode resolvePlatformImport}). The copies stand in for the originals by file URL. A
// module with a client transform is copied from its transformed source, so it keeps both.
//
// What this cannot see (an import spelled some way no rule here resolves) the bundle's own check
// catches: a client bundle that ships any `"use server"` module's source fails the build
// (./server-module-guard.ts).

import { extname, join, resolve, toFileUrl } from "@std/path";
import { actionIdFor } from "../runtime/server-action.ts";
import { composeRedirects } from "./platform-extensions.ts";
import { platformImportMap } from "./platform-imports.ts";

/** A `"use server"` module as the boundary records it: its file URL and its export names. */
export interface ServerModuleRef {
  /** The module's file URL. */
  readonly url: string;
  /** The names its stub exports (one action reference each). */
  readonly exports: readonly string[];
}

/** The `"use server"` modules to stub, by their stable module id (the boundary's `server`). */
export type ServerModules = Iterable<readonly [id: string, ref: ServerModuleRef]>;

/**
 * Generate a browser stub module for a `"use server"` module: each export becomes
 * a client dispatch stub (POSTs to the action endpoint). Used as the redirect
 * target so the real server module never reaches the browser bundle.
 *
 * @param moduleId The server module's stable id.
 * @param exports The server module's exported symbol names.
 * @returns The stub module source.
 */
export function generateServerStub(moduleId: string, exports: readonly string[]): string {
  const lines = exports.map((name) =>
    name === "default"
      ? `export default clientActionStub(${JSON.stringify(actionIdFor(moduleId, "default"))});`
      : `export const ${name} = clientActionStub(${JSON.stringify(actionIdFor(moduleId, name))});`
  );
  return `import { clientActionStub } from "denext/client-runtime";\n${lines.join("\n")}\n`;
}

/** The project root as written and as its real path (they differ under a symlink or `/var`). */
async function projectRoots(projectDir: string | null): Promise<string[]> {
  if (!projectDir) return [];
  const logical = toFileUrl(resolve(projectDir)).href + "/";
  try {
    const real = toFileUrl(await Deno.realPath(projectDir)).href + "/";
    return real === logical ? [logical] : [logical, real];
  } catch {
    return [logical];
  }
}

/**
 * Every file URL an import can reach `url` by: itself and its extensionless spelling, each under
 * the project's logical and real root (the boundary crawl reports real paths; the alias table
 * and the copies use the logical ones).
 */
function urlSpellings(url: string, roots: readonly string[]): string[] {
  const under = roots.find((r) => url.startsWith(r));
  const bases = under ? roots.map((r) => r + url.slice(under.length)) : [url];
  const out: string[] = [];
  for (const base of bases) {
    out.push(base);
    const ext = extname(new URL(base).pathname);
    if (ext) out.push(base.slice(0, -ext.length));
  }
  return out;
}

/**
 * Write an action stub for each of `server` into `dir`, returning the redirects that replace
 * each module (every spelling of its file URL) with its stub.
 */
async function writeServerStubs(
  server: ServerModules,
  dir: string,
  roots: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [id, ref] of server) {
    if (!ref.url.startsWith("file:")) continue;
    if (n === 0) await Deno.mkdir(dir, { recursive: true });
    const stub = join(dir, `action_${n++}.ts`);
    await Deno.writeTextFile(stub, generateServerStub(id, ref.exports));
    const to = toFileUrl(stub).href;
    for (const spelling of urlSpellings(ref.url, roots)) out[spelling] = to;
  }
  return out;
}

/** What a client bundle resolves the app's modules through ({@linkcode clientImportMap}). */
export interface ClientImports {
  /** The import-map entries: transforms, platform redirects, action stubs, rewritten copies. */
  readonly importMap: Record<string, string>;
  /** Each rewritten copy's file URL → the app module it stands in for. */
  readonly originals: Readonly<Record<string, string>>;
}

/** Options for {@linkcode clientImportMap}. */
export interface ClientImportOptions {
  /** The project root, whose import-map aliases are followed; null when the app has no config. */
  readonly projectDir: string | null;
  /** The target's platform-file redirects ({@linkcode projectPlatformRedirects}). */
  readonly redirects?: Readonly<Record<string, string>>;
  /** The client transforms: a module's file URL → its transformed file's URL. */
  readonly rewritten?: Readonly<Record<string, string>>;
  /** The `"use server"` modules, each replaced by its action stub. */
  readonly server?: ServerModules;
  /** A scratch directory for the stubs and copies (the caller removes it). */
  readonly dir: string;
}

/**
 * The import map a client bundle resolves through (see the module comment): the client
 * transforms, the platform redirects and an action stub for every `"use server"` module, plus
 * rewritten copies of the app modules that reach any of those through an import-map alias.
 *
 * @param opts What to resolve and where to write the stubs and copies.
 * @returns The import map and the originals of its copies.
 */
export async function clientImportMap(opts: ClientImportOptions): Promise<ClientImports> {
  const roots = await projectRoots(opts.projectDir);
  const stubs = await writeServerStubs(opts.server ?? [], join(opts.dir, "actions"), roots);
  // A platform redirect onto a `"use server"` variant goes straight to that variant's stub.
  const redirects = { ...composeRedirects({ ...opts.redirects }, stubs), ...stubs };
  const rewritten = opts.rewritten ?? {};
  const map = opts.projectDir
    ? await platformImportMap(opts.projectDir, redirects, join(opts.dir, "copies"), rewritten)
    : { importMap: redirects, originals: {} };
  return {
    importMap: { ...rewritten, ...composeRedirects(map.importMap, rewritten) },
    originals: map.originals,
  };
}
