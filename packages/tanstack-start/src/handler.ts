// The request side: the client bundle's files under `/_tss/`, and every other GET / HEAD page
// request rendered by TanStack Router's SSR (the generated server entry), the client entry named
// in the router manifest so the root route's `<Scripts />` emits it.

import { join } from "@std/path";

/** The URL prefix the client bundle is served under. */
const CLIENT_PREFIX = "/_tss/";

/** The client entry's file name in the client directory. */
export const CLIENT_ENTRY = "client.js";

/** What the handler needs. */
export interface HandlerOptions {
  /** Imports the generated server entry (the plugin context's `load`). */
  loadServerEntry: () => Promise<
    { render(request: Request, manifest: unknown): Promise<Response> }
  >;
  /** The client bundle's directory, once built (dev builds it on first use). */
  client: () => Promise<string>;
  /** The app's `basePath` (`""` when none). */
  basePath: string;
}

/**
 * React Router's manifest shape for the client entry: a module script on the root route, which
 * TanStack's `<Scripts />` renders into the document.
 */
export function routerManifest(src: string): unknown {
  return { routes: { __root__: { scripts: [{ attrs: { type: "module", src, async: true } }] } } };
}

/** The plugin's request handler. */
export function createHandler(
  opts: HandlerOptions,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const url = new URL(request.url);
    const path = opts.basePath && url.pathname.startsWith(opts.basePath)
      ? url.pathname.slice(opts.basePath.length) || "/"
      : url.pathname;
    if (path.startsWith(CLIENT_PREFIX)) return await clientFile(opts, path);
    // A file request (an extension) the router doesn't own falls through to denext.
    if (/\.[a-z0-9]+$/i.test(path)) return null;
    await opts.client();
    const entry = await opts.loadServerEntry();
    return await entry.render(
      request,
      routerManifest(`${opts.basePath}${CLIENT_PREFIX}${CLIENT_ENTRY}`),
    );
  };
}

async function clientFile(opts: HandlerOptions, path: string): Promise<Response> {
  const name = path.slice(CLIENT_PREFIX.length);
  if (!/^[\w.-]+\.js$/.test(name)) return new Response("Not Found", { status: 404 });
  const body = await Deno.readFile(join(await opts.client(), name)).catch(() => null);
  if (body === null) return new Response("Not Found", { status: 404 });
  return new Response(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // The entry keeps its name across builds; the chunks it imports are content-hashed.
      "cache-control": name === CLIENT_ENTRY ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}
