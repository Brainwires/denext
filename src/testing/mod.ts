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
 * (pass it to {@linkcode createTestClient} as before), plus `close()` to stop what the app
 * started — its `services/`, its `jobs/` registrations, and its `denext.config.ts` plugins'
 * teardowns. `await using app = await createTestApp(dir)` closes it at the end of the scope.
 */
export interface TestApp extends AsyncDisposable {
  /** Handle one request in process. */
  (request: Request): Response | Promise<Response>;
  /**
   * Stop the app's services, unregister its jobs and run its plugin teardowns (a no-op when it
   * started none; later calls do nothing).
   */
  close(): Promise<void>;
}

/**
 * What {@linkcode createTestApp} starts beside the request handler. Every field defaults to
 * `true`; pass `false` to leave that part out.
 */
export interface TestAppOptions {
  /**
   * Run the plugins' build steps (`addBuildStep`) as `denext build` does, and serve the files
   * they emit (`emitFile`). They write into a temporary directory, removed by `close()`, never
   * the project's `.denext/`.
   */
  buildSteps?: boolean;
  /**
   * Register every `jobs/**` module, so `runJob(name)` from `denext/server` runs it (in a test or
   * from a route the test requests). No schedule fires; `close()` aborts the runs in flight.
   */
  jobs?: boolean;
  /**
   * Start `services/**` under their supervisor, as `denext start` does; `close()` stops them.
   * The services' supervision is process-wide: close one test app before starting another.
   */
  services?: boolean;
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
 * (`@denext/pages-router`) or a plugin-served route answers here too. Their build steps run as
 * well, and the files they emit are served. `jobs/` is registered (`runJob` works) and
 * `services/` is started, as `denext start` does ({@linkcode TestAppOptions} turns each off).
 * Call `close()` (or `await using`) to stop the services and run the plugins' teardowns. Each
 * call gets its own plugin set.
 *
 * ```ts
 * import { createTestApp, createTestClient } from "@denext/denext/testing";
 * import { runJob } from "@denext/denext/server";
 * await using app = await createTestApp("./");
 * const client = createTestClient(app);
 * await runJob("cleanup");
 * ```
 *
 * @param projectDir The app directory (contains `app/` or `pages/`, optional `middleware.ts`).
 * @param options What to start beside the handler (all of it by default).
 * @returns The in-process handler, with `close()` for the services, jobs and plugin teardowns.
 */
export async function createTestApp(
  projectDir: string,
  options: TestAppOptions = {},
): Promise<TestApp> {
  // The production server's boundary discovery, with no build and no client bundle — the
  // JavaScript-disabled surface this handler exercises (`buildTestHandler`).
  const { handler, close } = await buildTestHandler(projectDir, defaultLoader, undefined, {
    buildSteps: options.buildSteps ?? true,
    jobs: options.jobs ?? true,
    services: options.services ?? true,
  });
  let closed: Promise<void> | undefined;
  const closeOnce = () => (closed ??= close());
  return Object.assign((request: Request) => handler(request), {
    close: closeOnce,
    [Symbol.asyncDispose]: closeOnce,
  });
}

// React's `act()` — flush renders, effects and scheduled work around an interaction.
export { act } from "../client/mod.ts";
