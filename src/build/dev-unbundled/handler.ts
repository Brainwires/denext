// Unbundled dev: HTTP handling — one function per URL class under `/_denext/`.

import { join } from "@std/path";
import { withinDir } from "../dev-server/dev-endpoints.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import { ensureClientDeps, ensureNpmBundle } from "./deps.ts";
import { serveEntry, serveSpaEntry } from "./entries.ts";
import {
  DEP_PREFIX,
  EMPTY_MODULE,
  ENTRY_PATH,
  FS_PREFIX,
  norm,
  NPM_PREFIX,
  type UnbundledState,
} from "./state.ts";
import { transform } from "./transform.ts";

const jsHeaders = {
  "content-type": "text/javascript; charset=utf-8",
  "cache-control": "no-store",
} as const;

function js(code: string, status = 200): Response {
  return new Response(code, { status, headers: jsHeaders });
}

function errStub(what: string, err: unknown): string {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return `console.error(${JSON.stringify(`denext dev transform error (${what}):\n` + msg)});`;
}

/** Run `produce` and serve its JS, or a console.error stub (500) naming `what`. */
async function serveJs(what: string, produce: () => Promise<string>): Promise<Response> {
  try {
    return js(await produce());
  } catch (err) {
    return js(errStub(what, err), 500);
  }
}

/** Serve a pre-bundled file from `dir`, 404 when absent. */
async function serveBundled(dir: string, name: string, kind: string): Promise<Response> {
  try {
    return js(await Deno.readTextFile(join(dir, name)));
  } catch {
    return js(`// ${kind} not found: ${name}`, 404);
  }
}

/**
 * `/_denext/@dep/<name>`: compat serves react/next/denext from the react→denext runtime
 * prebuild; native serves the denext-only @dep set. Runtime + native chunks
 * (`chunk-*.js`) live in the same dir as their entries, so one read covers both.
 */
async function serveDep(st: UnbundledState, path: string): Promise<Response> {
  try {
    await ensureClientDeps(st);
  } catch (err) {
    return js(errStub("dep prebundle", err), 500);
  }
  const name = path.slice(DEP_PREFIX.length);
  return serveBundled(st.compat ? st.runtimeDir : st.depDir, name, "dep");
}

/** `/_denext/@npm/<name>`: the compat on-demand npm bundle. */
async function serveNpm(st: UnbundledState, path: string): Promise<Response> {
  try {
    await ensureNpmBundle(st);
  } catch (err) {
    return js(errStub("npm prebundle", err), 500);
  }
  return serveBundled(st.npmDir, path.slice(NPM_PREFIX.length), "npm dep");
}

/**
 * Whether `/_denext/@fs<abs>` may serve `abs`: a file under the project (real paths on both
 * sides, so an in-project symlink pointing outside is refused) or a module the dev graph
 * itself imported (a workspace package or the local framework checkout). Anything else is
 * an arbitrary-file read and is refused.
 */
export function fsPathAllowed(st: UnbundledState, abs: string): boolean {
  if (st.importers.has(abs) || st.known.has(abs)) return true;
  try {
    const real = Deno.realPathSync(abs);
    const root = Deno.realPathSync(st.opts.projectDir);
    return withinDir(real, root) && Deno.statSync(real).isFile;
  } catch {
    return false;
  }
}

/** `/_denext/@fs<abs>`: one first-party module, transformed on demand. */
function serveFs(st: UnbundledState, path: string): Promise<Response> {
  let abs: string;
  try {
    abs = norm(decodeURIComponent(path.slice(FS_PREFIX.length)));
  } catch {
    return Promise.resolve(js("// bad @fs path", 400));
  }
  if (!fsPathAllowed(st, abs)) return Promise.resolve(js("// forbidden: outside the project", 403));
  return serveJs(abs, async () => (await transform(st, abs)).code);
}

/** `/_denext/@entry[?p=<route>]`: the generated client entry (route, or the SPA entry). */
function serveEntryRequest(
  st: UnbundledState,
  url: URL,
  manifest: RouteManifest,
): Promise<Response> {
  const routePath = url.searchParams.get("p");
  // SPA: no `?p=` — serve the single app entry unbundled.
  if (routePath === null && st.opts.spaEntry) return serveJs("spa entry", () => serveSpaEntry(st));
  const route = manifest.pages.find((p) => p.routePath === routePath);
  if (!route) return Promise.resolve(js("// route not found", 404));
  return serveJs("entry", async () => {
    // The deps must be built before the entry runs (it imports denext/client).
    await ensureClientDeps(st);
    return serveEntry(st, route);
  });
}

/** Handle an unbundled dev request, or return null if the URL isn't ours. */
export function handle(
  st: UnbundledState,
  url: URL,
  manifest: RouteManifest,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === EMPTY_MODULE) return Promise.resolve(js("export default {};\n"));
  if (path.startsWith(DEP_PREFIX)) return serveDep(st, path);
  if (path.startsWith(NPM_PREFIX)) return serveNpm(st, path);
  if (path.startsWith(FS_PREFIX)) return serveFs(st, path);
  if (path === ENTRY_PATH) return serveEntryRequest(st, url, manifest);
  return Promise.resolve(null);
}
