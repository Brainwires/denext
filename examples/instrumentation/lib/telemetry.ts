// A tiny in-process event log shared between instrumentation.ts and the routes that
// display it. In a real app this is where you'd forward to Sentry / OpenTelemetry /
// your logging backend; here it just records events so the example (and its e2e) can
// observe that `register()` ran at boot and `onRequestError` fired on a real error.
//
// It's a plain module singleton: instrumentation.ts and app/telemetry both import it,
// and Deno's module cache gives them the same instance within the server process.

/** One recorded lifecycle/observability event. */
export interface TelemetryEvent {
  /** `"register"` (boot) or `"requestError"` (a reported server-side error). */
  phase: "register" | "requestError";
  /** A human-readable detail string (route type + path + message for errors). */
  detail: string;
}

const events: TelemetryEvent[] = [];

/** Append an event to the log. */
export function record(event: TelemetryEvent): void {
  events.push(event);
}

/** A snapshot copy of the recorded events. */
export function snapshot(): TelemetryEvent[] {
  return [...events];
}
