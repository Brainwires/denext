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

export {
  cacheStoreContract,
  rateLimitStoreContract,
  sessionStoreContract,
  StoreContractError,
} from "./store-contracts.ts";
export type { ContractContext, StoreFactory } from "./store-contracts.ts";
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

import { defaultLoader } from "../server/mod.ts";
import type { TestHandler } from "./client.ts";
import { buildTestHandler } from "./conformance.ts";

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
  // The production server's boundary discovery, with no build and no client bundle — the
  // JavaScript-disabled surface this handler exercises (`buildTestHandler`).
  return (await buildTestHandler(projectDir, defaultLoader)).handler;
}

// React's `act()` — flush renders, effects and scheduled work around an interaction.
export { act } from "../client/mod.ts";
