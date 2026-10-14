// A denext app with `backend({ functions })` and denext auth, run through the real request
// pipeline, for the Edge Functions tests: write the functions into its temp project, then call it.

import { applyPlugins, getPluginRequestHandler, resetPlugins } from "../src/plugin/mod.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { issueAuthSession } from "../src/server/auth/session.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { backend, type BackendOptions } from "../packages/backend/mod.ts";
import { runPluginTeardown } from "../src/plugin/mod.ts";
import { ORIGIN, pipelineCaller } from "./_backend-app.ts";

export { ORIGIN };

const load = ((path: string) => import(path)) as unknown as ModuleLoader;

const authConfig: AuthConfig = {
  secret: "functions-secret-at-least-32-characters!",
  canonicalOrigin: ORIGIN,
  providers: [credentials({ authorize: () => null })],
};

/** A signed-in user's session cookie. */
export async function cookieFor(id: string): Promise<string> {
  const issuing = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(issuing, () => issueAuthSession(authConfig, { id }, "credentials"));
  return issuing.outgoingHeaders.getSetCookie().find((c) => c.startsWith("__Host-denext_auth="))!
    .split(";")[0];
}

/** The app. */
export interface FunctionsApp {
  root: string;
  handler: (request: Request) => Promise<Response>;
  /** `fetch` against the app: same-origin unless `crossSite`. */
  call(
    path: string,
    init?: RequestInit & { cookie?: string; crossSite?: boolean },
  ): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Build the app: `files` (relative paths → source) are written into the project first.
 *
 * @param files The project's files.
 * @param options The backend options (`functions` defaults to `{}`).
 * @param mode The pipeline mode.
 * @param app More of the app's config (`canonicalOrigin`, …).
 * @returns The app.
 */
export async function functionsApp(
  files: Record<string, string>,
  options: BackendOptions = { functions: {} },
  mode: "dev" | "prod" = "prod",
  app: Partial<DenextConfig> = {},
): Promise<FunctionsApp> {
  const root = await Deno.makeTempDir({ prefix: "dnx-functions-" });
  await Deno.mkdir(`${root}/app`);
  for (const [path, source] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, source);
  }
  resetPlugins();
  const config = { ...app, plugins: [denextAuth(authConfig), backend(options)] } as DenextConfig;
  await applyPlugins({ projectRoot: root, appDir: `${root}/app`, config, mode, load });
  const manifest = await scanRoutes(`${root}/app`);
  const handler = createApp({
    getManifest: () => manifest,
    load,
    matchExternal: getPluginRequestHandler(),
  });
  const call = pipelineCaller(handler);
  return {
    root,
    handler,
    call,
    async close() {
      await runPluginTeardown();
      resetPlugins();
      await Deno.remove(root, { recursive: true });
    },
  };
}
