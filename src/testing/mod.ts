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
import { buildTestHandler } from "./conformance.ts";

/**
 * The handler {@linkcode createTestApp} returns: still a plain `(Request) => Response` function
 * (pass it to {@linkcode createTestClient} as before), plus `close()` to run the teardowns of the
 * app's `denext.config.ts` plugins. `await using app = await createTestApp(dir)` closes it at
 * the end of the scope.
 */
export interface TestApp extends AsyncDisposable {
  /** Handle one request in process. */
  (request: Request): Response | Promise<Response>;
  /** Run the app's plugin teardowns (a no-op without plugins; later calls do nothing). */
  close(): Promise<void>;
}

/**
 * Build an in-process request handler for a real project directory — **no build
 * step, no socket**. It renders Server Components, runs Server Actions and
 * `middleware.ts`, and reads cookies/sessions, exactly as production does, but it
 * ships no client bundle — so it drives the **JavaScript-disabled** path your app
 * must support. The handler keeps one `PageCache`, so `revalidate`-based ISR is
 * exercised across successive requests. Pair it with {@linkcode createTestClient}.
 *
 * The `plugins` in the project's `denext.config.ts` run as they do under `denext dev`: their
 * prepare steps once, their route synthesizers over the scanned routes, and their request
 * handlers for what the App Router does not match — so a Pages Router app
 * (`@denext/pages-router`) or a plugin-served route answers here too. Call `close()` (or
 * `await using`) to run the plugins' teardowns. Each call gets its own plugin set.
 *
 * ```ts
 * import { createTestApp, createTestClient } from "@denext/denext/testing";
 * await using app = await createTestApp("./");
 * const client = createTestClient(app);
 * ```
 *
 * @param projectDir The app directory (contains `app/` or `pages/`, optional `middleware.ts`).
 * @returns The in-process handler, with `close()` for the plugin teardowns.
 */
export async function createTestApp(projectDir: string): Promise<TestApp> {
  // The production server's boundary discovery, with no build and no client bundle — the
  // JavaScript-disabled surface this handler exercises (`buildTestHandler`).
  const { handler, close } = await buildTestHandler(projectDir, defaultLoader);
  let closed: Promise<void> | undefined;
  const closeOnce = () => (closed ??= close());
  return Object.assign((request: Request) => handler(request), {
    close: closeOnce,
    [Symbol.asyncDispose]: closeOnce,
  });
}

// React's `act()` — flush renders, effects and scheduled work around an interaction.
export { act } from "../client/mod.ts";
