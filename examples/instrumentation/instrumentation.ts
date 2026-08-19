// A Next.js-style `instrumentation.ts` at the project root. denext auto-discovers it
// and, in both `dev` and `start`, runs `register()` once at boot and calls
// `onRequestError` for every server-side error while handling a request. Both hooks
// may be async; a throw from either is logged and never takes the server down.
//
// This example just records events into lib/telemetry so /telemetry can display them
// (and the e2e can assert them). A real app would set up tracing/metrics in
// `register()` and forward errors to Sentry/etc. in `onRequestError`.

import type { RequestErrorContext } from "denext/server";
import { record } from "./lib/telemetry.ts";

/** Run once when the server boots — set up observability here. */
export function register(): void {
  record({ phase: "register", detail: "server booted" });
  console.log("[instrumentation] register() ran at boot");
}

/** Report a server-side request error (Next-shaped context: routeType, routePath, …). */
export function onRequestError(
  error: unknown,
  _request: Request,
  context: RequestErrorContext,
): void {
  const message = error instanceof Error ? error.message : String(error);
  record({
    phase: "requestError",
    detail: `${context.routeType} ${context.routePath}: ${message}`,
  });
  console.error(
    `[instrumentation] onRequestError: ${context.routeType} ${context.routePath} — ${message}`,
  );
}
