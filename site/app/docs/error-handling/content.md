---
title: Error handling
slug: error-handling
lead: error.tsx and global-error.tsx boundaries, notFound / forbidden / unauthorized, useErrorBoundary, what happens to an error thrown in an event handler or a Server Action, and how production redaction and request ids let you find the cause.
---

denext catches errors the same way the Next.js App Router does — a file
convention per segment, control-flow helpers for the 404/403/401 cases, and
redaction on the way out. This page is the map: which boundary catches what,
and where each mechanism is documented in full.

## `error.tsx`

A segment's `error.tsx` is a `"use client"` component that receives
`{ error, reset }`. `error` is an `Error` that may carry a `digest`; `reset()`
clears the caught error and re-attempts rendering the boundary's children.

```tsx
// app/dashboard/error.tsx
"use client";

export default function DashboardError(
  { error, reset }: { error: Error & { digest?: string }; reset: () => void },
) {
  return (
    <section>
      <p>{error.message}</p>
      <button type="button" onClick={reset}>Try again</button>
    </section>
  );
}
```

Boundaries nest: each route level wraps `layout → template → error → loading →
children`, so a throw in a nested `layout.tsx` is caught by the nearest
_ancestor_ segment's `error.tsx`, and an outer `error.tsx` is the fallback for
an inner one. The file conventions themselves are owned by
[Routing](/docs/routing).

## `global-error.tsx`

`global-error.tsx` replaces the root layout and renders its own document — it
is the boundary for a failure that escapes every segment. It hydrates on the
native `denext build` and `denext dev` paths, so `reset` and any author
interactivity work like Next. `reset` recovers **softly**: it re-fetches the
current route and swaps the document in place (no browser reload), falling back
to a hard reload only if the re-fetch fails.

> [!WARNING]
> "`global-error.tsx` hydration is not wired on the next-compat /
> static-export paths." Those two paths emit no entry, so there global-error
> stays server-rendered only and its `reset` is inert. See
> [Known limitations](/docs/limitations).

## `notFound()`, `forbidden()`, `unauthorized()`

These are server-side control signals, caught per segment by that level's
`not-found.tsx` / `forbidden.tsx` / `unauthorized.tsx` — the boundary sits
inside the level's own layout, so a throw from a _layout_ escalates to the
parent level, and the response is 404/403/401. [Routing](/docs/routing) has the
full nesting and status rule. Two things differ from Next: in a `route.ts`
handler they are HTTP responses (the redirect with its status, or the code as a
JSON error envelope), and one thrown during a **client** render terminates that
render rather than swapping in the boundary — per Next's own "terminates
rendering of the route segment" contract. See
[Deliberate differences](/docs/differences).

## `useErrorBoundary()`

`useErrorBoundary()` (from `denext`) returns `{ captureError, reset }` for the
nearest enclosing boundary, so you can route errors a boundary cannot catch
during render — rejected promises, `setTimeout` callbacks, other async
failures. It is inert during server rendering.

```tsx
"use client";
import { useEffect, useErrorBoundary } from "denext";

export function Poller({ url }: { url: string }) {
  const { captureError } = useErrorBoundary();
  useEffect(() => {
    const id = setInterval(
      () => void fetch(url).catch(captureError),
      5000,
    );
    return () => clearInterval(id);
  }, [url, captureError]);
  return null;
}
```

denext also differs here on purpose: **an error thrown in a DOM event handler
is routed to the nearest error boundary.** React lets it reach
`window.onerror` and keeps the UI up; denext catches it (`onCaughtError` sees
it) and shows the fallback, so one bad click swaps out that boundary's subtree.
Wrap the handler body in `try/catch` when you want React's behavior —
[Deliberate differences](/docs/differences).

## Root error callbacks

`createRoot` / `hydrateRoot` accept React 19's `onCaughtError`,
`onUncaughtError` and `onRecoverableError` (routed through denext's
reconciler). They **observe** error handling without changing it: a boundary
still catches, an uncaught error still surfaces, a hydration mismatch still
keeps the client render — `onRecoverableError` replaces the dev-only mismatch
console warning.

```ts
import { hydrateRoot } from "denext/client";

hydrateRoot(container, tree, {
  onCaughtError: (err, info) => report(err, info.componentStack),
});
```

## Server Actions and API routes

`defineAction` handler errors are **redacted in production** — the client sees
`"Internal Server Error"` plus a `digest` that correlates with the server log,
exactly like a render error handed to `error.tsx`. An `ActionValidationError`
is authored for the user, so its message and `fieldErrors` pass through
verbatim.

`defineApi` follows the same split: a thrown `ApiError(status, code, { data })`
(and a schema `validation` failure) passes through as the JSON error envelope,
while any other throw becomes a redacted JSON 500 —
`{ error: { code: "internal", message: "Internal Server Error", digest } }`. A
plain `route.ts` handler's unknown throw keeps the text 500 it always had. The
envelope and its client-side `ApiClientError` shape belong to
[Typed API](/docs/typed-api); the action side to
[Server Actions](/docs/server-actions).

## Finding the cause

A `500` carries an `x-request-id` response header. Run the server with
`DENEXT_LOG=json` and grep the structured log for that `requestId` to find the
full server-side error and its `digest`. For a programmatic sink, export
`onRequestError` from a root `instrumentation.ts` and wire it to your tracer.
The [deployment guide](/docs/deploy) owns observability — §14 for `onRequest` /
`onRequestError` and the OpenTelemetry recipe, §15 for the "correlate an error"
runbook step.

> [!NOTE]
> `denext doctor` and `probeApp` see a crash only as the framework's bare 500.
> A server error that a segment `error.tsx` caught and rendered at status 200
> looks like a rendered page to the probe — assert on those routes yourself.

## In development

Nothing is redacted in dev: the real error is passed to the boundary, and the
in-browser overlay shows a **codeframe** (the source snippet with a caret at
the failing column) plus a **clickable frame that opens the file in your
editor**, honoring `DENEXT_EDITOR` / `VISUAL` / `EDITOR` (VS Code, JetBrains,
Sublime, and terminal editors; default `code`). Build, server-render and type
errors surface in the same overlay.
