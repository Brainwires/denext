// A real denext request pipeline (createApp + the plugin seam) around `@denext/backend`, for the
// storage tests: requests run inside the request context, so `auth()`, `csrf()` and the
// buckets' `authorize` see exactly what they see in an app.

import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import type { DenextPlugin } from "../src/plugin/mod.ts";
import {
  applyPlugins,
  getPluginRequestHandler,
  resetPlugins,
  runPluginTeardown,
} from "../src/plugin/mod.ts";
import { createApp } from "./helpers/released-app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { backend, fs } from "../packages/backend/mod.ts";
import type { StorageOptions } from "../packages/backend/mod.ts";
import { installRuntime } from "../packages/backend/src/runtime.ts";
import { type ResponseBodies, responseBodies } from "./helpers/response-bodies.ts";

export const ORIGIN = "https://app.test";
export const SECRET = "storage-secret-at-least-32-characters";
const load = ((path: string) => import(path)) as unknown as ModuleLoader;

/** A test app: call it like a server, then `close()` it. */
export interface BackendApp {
  root: string;
  handler: (request: Request) => Promise<Response>;
  /** `fetch`-like: an app-relative or absolute URL against {@link ORIGIN}. */
  call(
    path: string,
    init?: RequestInit & { cookie?: string; crossSite?: boolean },
  ): Promise<Response>;
  /** POST JSON to the sign route (same-origin by default). */
  sign(body: unknown, init?: { cookie?: string; crossSite?: boolean }): Promise<Response>;
  close(): Promise<void>;
}

/**
 * `fetch` against an app's handler at {@link ORIGIN}: a write is same-origin unless `crossSite`,
 * and `cookie` rides along.
 *
 * @param handler The app's handler.
 * @returns The caller.
 */
export function pipelineCaller(
  handler: (request: Request) => Promise<Response>,
  bodies?: ResponseBodies,
): BackendApp["call"] {
  return async (path, init = {}) => {
    const { cookie, crossSite, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("host", new URL(ORIGIN).host);
    if (cookie) headers.set("cookie", cookie);
    if (rest.method && rest.method !== "GET" && rest.method !== "HEAD" && !headers.has("origin")) {
      headers.set("origin", crossSite ? "https://evil.test" : ORIGIN);
    }
    const res = await handler(new Request(new URL(path, ORIGIN), { ...rest, headers }));
    return bodies ? bodies.track(res) : res;
  };
}

/** Build the app with `backend({ storage })` (fs driver in a temp dir unless given). */
export async function backendApp(
  storage: Partial<StorageOptions> & Pick<StorageOptions, "buckets">,
  options: { plugins?: DenextPlugin[]; config?: Partial<DenextConfig>; mode?: "prod" | "dev" } = {},
): Promise<BackendApp> {
  const root = await Deno.makeTempDir({ prefix: "dnx-backend-" });
  await Deno.mkdir(`${root}/app`);
  resetPlugins();
  installRuntime(undefined);
  const config = {
    ...options.config,
    plugins: [
      ...(options.plugins ?? []),
      backend({ storage: { secret: SECRET, driver: fs({ dir: ".storage" }), ...storage } }),
    ],
  } as DenextConfig;
  await applyPlugins({
    projectRoot: root,
    appDir: `${root}/app`,
    config,
    mode: options.mode ?? "prod",
    load,
  });
  const manifest = await scanRoutes(`${root}/app`);
  const handler = createApp({
    getManifest: () => manifest,
    load,
    matchExternal: getPluginRequestHandler(),
    basePath: config.basePath,
  });
  const bodies = responseBodies();
  const call = pipelineCaller(handler, bodies);
  return {
    root,
    handler,
    call,
    sign: (body, init = {}) =>
      call("/_denext/storage/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...init,
      }),
    async close() {
      // The teardowns close what setup opened (the storage metadata database): Windows
      // refuses to remove a directory with an open file in it.
      await bodies.release();
      await runPluginTeardown();
      resetPlugins();
      installRuntime(undefined);
      await Deno.remove(root, { recursive: true });
    },
  };
}
