# Instrumentation on denext

A Next.js-style [`instrumentation.ts`](./instrumentation.ts) at the project
root. denext auto-discovers it and, in both `dev` and `start`:

- runs **`register()`** once when the server boots — where you'd set up tracing,
  metrics, error reporting, connection pools, …;
- calls **`onRequestError(error, request, context)`** for every server-side
  error while handling a request — where you'd forward to Sentry / OpenTelemetry
  / your logs. The `context` matches Next's shape (`routerKind`, `routePath`,
  `routeType`, `renderSource`, `revalidateReason`), so instrumentation written
  for Next works unchanged.

Both hooks may be async, and a throw from either is logged and swallowed — a
broken instrumentation setup can never take the server down.

This example records each event into a tiny in-process log
([`lib/telemetry.ts`](./lib/telemetry.ts)) that the
[`/telemetry`](./app/telemetry) page displays, so you can watch `register()`
fire at boot and `onRequestError` fire when you trigger an error.

## Run it

```sh
deno task dev        # http://localhost:3000   (or: deno task build && deno task start)
```

Then:

- open **`/telemetry`** — you'll already see the `register` event from boot;
- hit **`/boom`** (a Server Component that throws) — a redacted 500 to the
  client, but `/telemetry` now shows an `onRequestError` with
  `routeType: render`, `routePath: /boom`;
- submit the **action-error** form on `/` — `/telemetry` gains an entry with
  `routeType: action`.

The client only ever sees `Internal Server Error` (denext redacts error text in
production); the _real_ error reaches `onRequestError` for your backend.

## Files

- [`instrumentation.ts`](./instrumentation.ts) — the root hook module
  (`register` + `onRequestError`).
- [`lib/telemetry.ts`](./lib/telemetry.ts) — the shared in-process event log.
- [`app/boom/page.tsx`](./app/boom/page.tsx) — a Server Component that throws
  (render error).
- [`app/actions.ts`](./app/actions.ts) — a `"use server"` action that throws
  (action error).
- [`app/telemetry/page.tsx`](./app/telemetry/page.tsx) — renders the recorded
  events.

End-to-end test: `tests/e2e/instrumentation.e2e.test.ts` (`deno task test:e2e`).
