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
is the boundary for a failure that escapes every segment. It hydrates on every
path (`denext build` and `denext dev`, native and next-compat alike), so `reset`
and any author interactivity work like Next. `reset` recovers **softly**: it
re-fetches the current route and swaps the document in place (no browser
reload), falling back to a hard reload only if the re-fetch fails.

A static site has no server to render it on a failing request, so
`denext export` pre-renders global-error to `out/500.html`, wired to the same
hydration entry, for a host that serves a custom error page. It receives the
error a production server hands it: the message `Internal Server Error`.

With neither `error.tsx` nor `global-error.tsx` to catch it, a page error answers a minimal HTML
page (`500`, "Internal Server Error." and the request id), as Next.js serves its default error
page; a request that doesn't accept `text/html` gets the same text as `text/plain`. Neither says
anything about the error: the server log has it, under that request id.

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

A **Server Action** the browser calls may throw them too, as in Next. The call rejects with the
same signal (`isNotFound(err)` holds, `unstable_rethrow` passes it on), and once it reaches the
client tree (an event handler that returns the call's promise, a `<form action>`,
`useActionState`) the server renders the current URL with the signal raised at the page: the
page level's nearest `not-found.tsx` / `forbidden.tsx` / `unauthorized.tsx` replaces the page in
place under the layouts. The URL stays and nothing reloads; `redirect()` from an action still
navigates. A caller that catches the rejection itself decides what happens instead.

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
> `denext doctor` and `probeApp` fail a route whose `error.tsx` caught a server error and
> rendered at status 200 (the `no-caught-error` check, with the error's message and digest).
> They read it through their own `onRequestError` hook, so the response carries nothing more.
> A streamed Suspense hole that threw with no `error.tsx` inside it keeps its fallback; the
> server reports that error to `onRequestError` too, and the probes fail the route
> (`no-stuck-hole`).

## In development

Nothing is redacted in dev: the real error is passed to the boundary, and the
in-browser overlay shows a **codeframe** (the source snippet with a caret under
the failing column) plus a **clickable frame that opens the file in your
editor**, honoring `DENEXT_EDITOR` / `VISUAL` / `EDITOR` (VS Code, JetBrains,
Sublime, and terminal editors; default `code`). Build, server-render and type
errors surface in the same overlay.

### Explained type errors

`denext check`, `denext lint`, `denext build` and `denext dev` print each TypeScript, Deno and
denext-lint diagnostic they recognize as a short explanation: the problem in one line, a codeframe
(underlining the whole span the diagnostic covers), why it happens, and a concrete fix. The
original diagnostic is printed under it, unchanged:

```text
TS2322: Type mismatch at `author.email`
  at app/api/posts/route.ts:15:10

    14 |   response: schema<Post>(),
  > 15 | }, () => draft);
                  ^^^^^

  This `defineApi` handler returns `author.email` as `number`, but the route's `response`
  schema says `string`. The handler's return value must match the schema it declares.

  Fix: Return `author.email` as `string` — or, if `number` is right, change the `response` schema.

  Original (deno check):
  │ TS2322 [ERROR]: Type '{ id: number; title: string; author: { … }; }' is not assignable …
```

It covers:

- **Assignability** (`TS2322`, `TS2345`): the long generic chains from `defineApi`, schemas,
  `useApi` and `createApiClient` are collapsed to the one property path that mismatches.
- **Possibly `null` / `undefined`** (`TS18047`, `TS18048`, `TS2532`): why the value can be missing
  (`find`, `querySelector`, `Map.get`, …), with a guard and the optional-chaining form of the line.
- **Non-exhaustive switches**: the union members no `case` handles, from a `never` check or a
  function that falls off the end of its switch (`TS2366`).
- **Imports**: `react` / `next/*` in new code points to the denext import, a name used without
  importing it (`TS2304`) names the denext module that exports it, and a module that doesn't exist
  gets a did-you-mean from its directory.
- **Dependencies and module format**: a bare import nothing maps names the package to add
  (`denext add npm:zod`; a Node built-in gets its `node:` prefix), however the checker words it
  (`Import "zod" not a dependency` in TypeScript 6, `Cannot find module 'zod'` in TypeScript 7), and
  `import x = require()` / `export =` (`TS1202`, `TS1203`) get their ES module forms.
- **Compiler options**: an option TypeScript 7 removed (`baseUrl`, `moduleResolution: node`,
  `target: es5`; `TS5101`, `TS5102`, `TS5108`) gets the edit that replaces it, and a JSX runtime
  that doesn't resolve (`TS2875`, with its `TS7026`) the import-map entry it needs.
- **The typed API client**: an unknown route path or param gets the nearest real one.
- **denext's lint rules**: `directive-placement`, `rules-of-hooks`, `hooks-in-component`,
  `no-hooks-in-async` and `no-handlers-in-async`, and the opt-in `exhaustive-switch` and
  `no-throw` from [Errors as values](/docs/errors-as-values#lint-rules), whose fixes point at
  `assertNever`, `err()` and `tryAsync`.

In the browser the overlay shows the explanation first, with the original diagnostic in a
collapsed **Original diagnostic** section. Pass `--raw` to `denext check`, `lint`, `build` or `dev`,
or set `DENEXT_RAW_DIAGNOSTICS=1`, to get Deno's output exactly as it prints it. An agent can ask
for the same explanation through the [`denext_explain_error`](/docs/mcp) MCP tool.
