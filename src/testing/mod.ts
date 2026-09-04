/**
 * In-process app testing for denext — drive a request handler the way a browser
 * with **JavaScript disabled** would: follow redirects, keep a cookie jar across
 * requests, and submit the very `<form>` markup your Server Components rendered.
 *
 * This is the framework-agnostic core of denext's app-testing story. Get a handler
 * for a project with {@linkcode createTestApp} (in-process, no build, no socket),
 * or wrap any `(Request) => Response | Promise<Response>` handler you already have.
 *
 * ```ts
 * import { createTestApp, createTestClient } from "@denext/denext/testing";
 *
 * const client = createTestClient(await createTestApp("./"));
 *
 * // Log in through the rendered form — no client JS involved.
 * const page = await client.get("/login");
 * const form = client.form(page.text);
 * const res = await client.submit(form, { email: "a@b.c", password: "pw" });
 * // The session cookie is now in the jar; later requests are authenticated.
 * const home = await client.get("/");
 * ```
 *
 * For **component**-level testing (mount a single component with real hooks,
 * effects, and events), see {@linkcode render} and {@linkcode fireEvent}.
 *
 * @module
 */

export { fireEvent, render, userEvent, waitFor } from "./render.ts";
export { formatReport, probeApp } from "./conformance.ts";
export type { ConformanceReport, ProbeCheck, ProbeOptions, RouteProbe } from "./conformance.ts";

export { CookieJar, createTestClient } from "./client.ts";
export type {
  FormBody,
  FormQuery,
  RedirectHop,
  TestClient,
  TestClientOptions,
  TestForm,
  TestHandler,
  TestRequestInit,
  TestResponse,
} from "./client.ts";
export type {
  Component,
  FireEvent,
  Key,
  MatchOptions,
  Queries,
  RenderResult,
  RoleOptions,
  TestElement,
  TextMatch,
  UserEvent,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
  WaitOptions,
} from "./render.ts";

import {
  createApp,
  createMiddlewareRunner,
  defaultLoader,
  PageCache,
  scanRoutes,
} from "../server/mod.ts";
import type { TestHandler } from "./client.ts";
import { resolveProject } from "../build/paths.ts";
import {
  buildBoundaryManifest,
  computeBoundaryRoutes,
  importFunctionExports,
  routeEntryFiles,
} from "../build/module-graph.ts";
import { tagServerModules } from "../runtime/server-action.ts";
import { resolve, toFileUrl } from "@std/path";

/**
 * Build an in-process request handler for a real project directory — **no build
 * step, no socket**. It renders Server Components, runs Server Actions and
 * `middleware.ts`, and reads cookies/sessions, exactly as production does, but it
 * ships no client bundle — so it drives the **JavaScript-disabled** path your app
 * must support. The handler keeps one `PageCache`, so `revalidate`-based ISR is
 * exercised across successive requests. Pair it with {@linkcode createTestClient}.
 *
 * ```ts
 * import { createTestApp, createTestClient } from "@denext/denext/testing";
 * const client = createTestClient(await createTestApp("./"));
 * ```
 *
 * @param projectDir The app directory (contains `app/`, optional `middleware.ts`).
 * @returns A `(Request) => Promise<Response>` handler.
 */
export async function createTestApp(projectDir: string): Promise<TestHandler> {
  const paths = await resolveProject(resolve(projectDir));
  const manifest = await scanRoutes(paths.appDir);
  let getMiddleware: (() => ReturnType<typeof createMiddlewareRunner>) | undefined;
  if (paths.middlewarePath) {
    const mod = await import(toFileUrl(resolve(paths.middlewarePath)).href);
    const runner = createMiddlewareRunner(mod);
    getMiddleware = () => runner;
  }

  // Discover the "use client"/"use server" boundary by crawling the import graph
  // (the same pass the production server runs) — with no build. This is what lets
  // `<form action={serverActionFn}>` render a working endpoint URL and lets Server
  // Actions dispatch. Every discovered "use server" module is registered up front
  // so actions work on ALL routes, not only ones that also reach a client island.
  // No client bundle is emitted, which is exactly the JavaScript-disabled surface
  // this handler is meant to exercise.
  const boundary = await buildBoundaryManifest(
    paths.appDir,
    [...new Set(manifest.pages.flatMap(routeEntryFiles))],
    { exportsOf: importFunctionExports },
  );
  await tagServerModules(boundary.server);
  const flightRoutes = await computeBoundaryRoutes(paths.appDir, manifest.pages);

  return createApp({
    getManifest: () => manifest,
    load: defaultLoader,
    publicDir: paths.publicDir,
    getMiddleware,
    pageCache: new PageCache(),
    i18n: paths.i18n ?? undefined,
    flight: flightRoutes.size > 0,
    appDir: paths.appDir,
    flightRoutes,
    flightClients: boundary.client,
    flightServers: boundary.server,
  });
}
