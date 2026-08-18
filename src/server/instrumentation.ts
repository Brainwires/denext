// `instrumentation.ts` support: a project-root module for observability setup.
//
// A project may place an `instrumentation.{ts,js}` file at its root exporting:
//   - `register()`      — run once when the server boots (set up tracing,
//                         metrics, error reporting, DB pools, etc.);
//   - `onRequestError(error, request, context)` — called for each server-side
//                         error while handling a request (report to Sentry/etc.).
// Both may be async and are optional; either may be a named export or a property
// of the module's default export.

import { toFileUrl } from "@std/path";

/**
 * Context passed to {@linkcode OnRequestError} describing where the error
 * occurred — mirrors Next.js's `onRequestError` context so instrumentation
 * (Sentry, etc.) written for Next works unchanged.
 */
export interface RequestErrorContext {
  /** Which router served the request. denext's core is the App Router. */
  routerKind: "App Router" | "Pages Router";
  /** The matched route path/pattern being handled, if known (else the URL path). */
  routePath: string;
  /** What was being handled: a page render, an API route, a server action, or middleware. */
  routeType: "render" | "route" | "action" | "middleware";
  /** For a render error, which rendering path produced it. */
  renderSource?: "react-server-components" | "react-server-components-payload" | "server-rendering";
  /** Set when the error happened during a revalidation (ISR): on-demand vs stale-while-revalidate. */
  revalidateReason?: "on-demand" | "stale";
}

/** The `register` export: run once at server startup. */
export type RegisterFn = () => void | Promise<void>;

/** The `onRequestError` export: report a server-side request error. */
export type OnRequestError = (
  error: unknown,
  request: Request,
  context: RequestErrorContext,
) => void | Promise<void>;

/** The shape of a project's `instrumentation` module. */
export interface Instrumentation {
  /** Run once when the server starts. */
  register?: RegisterFn;
  /** Called for each server-side error during request handling. */
  onRequestError?: OnRequestError;
}

/**
 * Load a project's instrumentation module, accepting either named exports
 * (`export function register`) or a default-export object
 * (`export default { register }`). Returns an empty object when `path` is null or
 * the module fails to load (logged, non-fatal — instrumentation must never take
 * the server down).
 *
 * @param path Absolute path to the instrumentation module, or null.
 * @returns The resolved {@link Instrumentation} hooks.
 */
export async function loadInstrumentation(path: string | null): Promise<Instrumentation> {
  if (!path) return {};
  try {
    const mod = await import(toFileUrl(path).href) as
      & Instrumentation
      & { default?: Instrumentation };
    return {
      register: mod.register ?? mod.default?.register,
      onRequestError: mod.onRequestError ?? mod.default?.onRequestError,
    };
  } catch (err) {
    console.error("denext: failed to load instrumentation module", err);
    return {};
  }
}

/**
 * Invoke `register` once, swallowing and logging any error so a failed
 * instrumentation setup cannot prevent the server from starting.
 *
 * @param instrumentation The loaded instrumentation hooks.
 */
export async function runRegister(instrumentation: Instrumentation): Promise<void> {
  if (!instrumentation.register) return;
  try {
    await instrumentation.register();
  } catch (err) {
    console.error("denext: instrumentation register() threw", err);
  }
}
