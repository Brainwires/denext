// Unbundled dev: HTTP handling — one function per URL class under `/_denext/`.

import type { Platform } from "../platform-extensions.ts";
import { basename, extname, join, relative } from "@std/path";
import { contentType } from "@std/media-types";
import { withinDir } from "../dev-server/dev-endpoints.ts";
import type { RouteManifest } from "../../router/manifest.ts";
import { ensureClientDeps, ensureNpmBundle } from "./deps.ts";
import { serveEntry, serveSpaEntry } from "./entries.ts";
import { rewriteRuntimeBridges } from "./react-native.ts";
import { CODE_FILE } from "./resolve.ts";
import {
  DEP_PREFIX,
  EMPTY_MODULE,
  ENTRY_PATH,
  FS_PREFIX,
  fsPathOfUrl,
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

/**
 * Serve a pre-bundled file from `dir`, 404 when absent. A module passes through `rewrite`; a
 * non-module file (an asset the dependency bundle emitted) is served as bytes with its type.
 */
async function serveBundled(
  dir: string,
  name: string,
  kind: string,
  rewrite?: (code: string) => string,
): Promise<Response> {
  try {
    if (!name.endsWith(".js")) {
      const type = contentType(extname(name)) ?? "application/octet-stream";
      return new Response(await Deno.readFile(join(dir, name)), {
        headers: { "content-type": type, "cache-control": "no-store" },
      });
    }
    const code = await Deno.readTextFile(join(dir, name));
    return js(rewrite ? rewrite(code) : code);
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
  // React Native mode: the runtime's bare react-native-web bridge → the dependency bundle.
  const rewrite = st.opts.reactNative ? rewriteRuntimeBridges : undefined;
  return serveBundled(st.compat ? st.runtimeDir : st.depDir, name, "dep", rewrite);
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
 * Files `/_denext/@fs` never serves, wherever they sit (Vite's `server.fs.deny`): dotfiles and
 * dot-directories (`.env*`, `.git/`, `.denext/`, `.ssh/`, …) and key / certificate stores.
 */
const FS_DENIED_NAME = /^\.|\.(?:pem|key|p12|pfx|p8|jks|keystore|crt|cer|der|mobileprovision)$/i;

/** Whether a path segment of `rel` (separated by `/` or `\`) is denied by {@link FS_DENIED_NAME}. */
function deniedSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => segment !== "" && FS_DENIED_NAME.test(segment));
}

/**
 * Whether `/_denext/@fs<abs>` may serve `abs`. Never a denied file (a dotfile or dot-directory
 * inside the project, or one named like a key store anywhere). Otherwise a module the dev graph
 * itself imported (a workspace package or the local framework checkout), or a JS / TS / JSON
 * source under the project (real paths on both sides, so an in-project symlink pointing outside
 * is refused). Anything else — an arbitrary file, a non-module asset — is refused: the transform
 * would read it and echo its text back in an error.
 */
export function fsPathAllowed(st: UnbundledState, abs: string): boolean {
  let real: string;
  let root: string;
  try {
    real = Deno.realPathSync(abs);
    root = Deno.realPathSync(st.opts.projectDir);
  } catch {
    return false;
  }
  const inProject = withinDir(real, root);
  const denied = inProject ? deniedSegment(relative(root, real)) : deniedSegment(basename(real));
  if (denied || deniedSegment(basename(abs))) return false;
  if (st.importers.has(abs) || st.known.has(abs)) return true;
  try {
    return inProject && CODE_FILE.test(real) && Deno.statSync(real).isFile;
  } catch {
    return false;
  }
}

/** `/_denext/@fs<abs>`: one first-party module, transformed on demand. */
function serveFs(st: UnbundledState, path: string, platform: Platform): Promise<Response> {
  let abs: string;
  try {
    abs = norm(fsPathOfUrl(path.slice(FS_PREFIX.length)));
  } catch {
    return Promise.resolve(js("// bad @fs path", 400));
  }
  if (!fsPathAllowed(st, abs)) {
    return Promise.resolve(js("// forbidden: not a project module", 403));
  }
  return serveJs(abs, async () => (await transform(st, abs, platform)).code);
}

/** `/_denext/@entry[?p=<route>]`: the generated client entry (route, or the SPA entry). */
function serveEntryRequest(
  st: UnbundledState,
  url: URL,
  manifest: RouteManifest,
  platform: Platform,
): Promise<Response> {
  const routePath = url.searchParams.get("p");
  // SPA: no `?p=` — serve the single app entry unbundled.
  if (routePath === null && st.opts.spaEntry) {
    return serveJs("spa entry", () => serveSpaEntry(st, platform));
  }
  const route = manifest.pages.find((p) => p.routePath === routePath);
  if (!route) return Promise.resolve(js("// route not found", 404));
  return serveJs("entry", async () => {
    // The deps must be built before the entry runs (it imports denext/client).
    await ensureClientDeps(st);
    return serveEntry(st, route, platform);
  });
}

/**
 * Handle an unbundled dev request, or return null if the URL isn't ours. First-party modules
 * and entries are served for `platform` (the target the requesting page named).
 */
export function handle(
  st: UnbundledState,
  url: URL,
  manifest: RouteManifest,
  platform: Platform = "web",
): Promise<Response | null> {
  const path = url.pathname;
  if (path === EMPTY_MODULE) return Promise.resolve(js("export default {};\n"));
  if (path.startsWith(DEP_PREFIX)) return serveDep(st, path);
  if (path.startsWith(NPM_PREFIX)) return serveNpm(st, path);
  if (path.startsWith(FS_PREFIX)) return serveFs(st, path, platform);
  if (path === ENTRY_PATH) return serveEntryRequest(st, url, manifest, platform);
  return Promise.resolve(null);
}
