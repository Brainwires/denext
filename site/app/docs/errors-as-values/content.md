---
title: Errors as values
slug: errors-as-values
lead: denext/result gives you Result values, tryAsync / trySync around throwing calls, an exhaustive match() over unions, err() as a return value from defineApi and defineAction, and two opt-in lint rules. It is all opt-in, and React's own throws stay as they are.
---

Languages like Gleam and Rust have no exceptions for ordinary failures. A function that can
fail says so in its return type, and the compiler makes the caller handle every case.
`denext/result` brings that style to a denext app as a small, opt-in module. Nothing else in
denext depends on it, and an app that never imports it bundles none of it.

```ts
import { err, match, ok, type Result } from "denext/result";

type ParseError = "not_a_number" | "out_of_range";

function parsePort(raw: string): Result<number, ParseError> {
  const n = Number(raw);
  if (!Number.isInteger(n)) return err("not_a_number");
  return n > 0 && n < 65536 ? ok(n) : err("out_of_range");
}

const port = parsePort(input);
if (port.ok) listen(port.value);
else console.warn(`bad port: ${port.error}`); // port.error is "not_a_number" | "out_of_range"
```

## What stays a throw

This is not a way to remove exceptions from React. Several React and Next.js mechanisms
**are** throws, and they keep working the way they do in Next.js:

- **Suspense** suspends by throwing a promise.
- **`notFound()`, `redirect()`, `permanentRedirect()`, `forbidden()` and `unauthorized()`**
  are control flow. They throw a signal that the nearest boundary or the request pipeline
  handles.
- **Error boundaries** (`error.tsx`, `global-error.tsx`, `ErrorBoundary`) catch what a render
  throws. A bug is still a bug, and a boundary is still the right place to show it. See
  [Error handling](/docs/error-handling).
- **`fail()`** in `defineApi` and **`ActionValidationError`** in `defineAction` still work
  unchanged. `err()` is an alternative, not a replacement.

`tryAsync` and `trySync` know about these. They re-throw a thrown promise and denext's
control-flow signals instead of capturing them as an `Err`, so wrapping a data call never
swallows a `notFound()` or breaks Suspense.

Use `Result` for the failures your code expects and should handle: validation, "not found"
as data, a conflict, an upstream service being down. Leave bugs and React's control flow as
throws.

## The API

| Export                    | What it does                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Result<T, E>`            | Either `Ok<T>` or `Err<E>`, discriminated by `ok`.                                                                                      |
| `ok(value)`               | `{ ok: true, value }`.                                                                                                                  |
| `err(error, details?)`    | `{ ok: false, error, details? }`. A string literal keeps its literal type: `err("not_found")` is `Err<"not_found">`.                    |
| `isOk(r)` / `isErr(r)`    | Type guards. They read `.ok`, so they also work on a `Result` that went through JSON (a Server Component prop, a Server Action result). |
| `map(r, fn)`              | Transforms the success value. A failure passes through.                                                                                 |
| `mapErr(r, fn)`           | Transforms the error and keeps `details`. A success passes through.                                                                     |
| `andThen(r, fn)`          | Chains a step that can fail. The error type becomes the union of both.                                                                  |
| `unwrapOr(r, fallback)`   | The value, or `fallback`.                                                                                                               |
| `trySync(fn, mapError?)`  | Runs a throwing call and returns a `Result`. `mapError` types the error.                                                                |
| `tryAsync(fn, mapError?)` | The same for a promise or an async function.                                                                                            |
| `match(value)`            | An exhaustive matcher. See below.                                                                                                       |
| `assertNever(x)`          | For the `default` of a `switch`. It is a compile error while `x` can still be something.                                                |

The functions are standalone (`map(r, fn)`, not `r.map(fn)`). A `Result` is a plain object, so
it serializes, crosses the server-to-client boundary, and tree-shakes.

```ts
import { andThen, map, tryAsync, unwrapOr } from "denext/result";

const user = await tryAsync(
  () => fetch(`/api/users/${id}`).then((r) => r.json() as Promise<User>),
  () => "network" as const, // Result<User, "network">
);
const name = unwrapOr(map(user, (u) => u.name), "someone");
```

## Exhaustive matching

`match(value)` checks at the type level that every member of a literal union or a
discriminated union is handled:

```ts
import { match } from "denext/result";

type Shape =
  | { kind: "circle"; r: number }
  | { kind: "square"; side: number }
  | { kind: "rect"; w: number; h: number };

const area = (s: Shape) =>
  match(s)
    .with({ kind: "circle" }, (c) => Math.PI * c.r ** 2) // c is the circle member
    .with({ kind: "square" }, (q) => q.side ** 2)
    .with({ kind: "rect" }, (r) => r.w * r.h)
    .exhaustive();
```

Remove the `rect` case and `.exhaustive()` stops compiling. The error names what is missing
(`"denext: match is not exhaustive; unhandled cases": { kind: "rect"; … }`). Use
`.otherwise(fn)` instead of `.exhaustive()` for a deliberate catch-all.

A pattern is either a literal (`"idle"`, `404`, `null`) or an object of literals that the value
must match key by key (`{ kind: "circle" }`, `{ ok: false }`). Matching is shallow and uses
`===` (with `NaN` equal to `NaN`). The first pattern that matches wins. If a value outside the
declared type reaches `.exhaustive()` at runtime, it throws a `TypeError`.

A plain `switch` gets the same check from `assertNever`:

```ts
import { assertNever } from "denext/result";

function label(s: Shape): string {
  switch (s.kind) {
    case "circle":
      return "round";
    case "square":
    case "rect":
      return "boxy";
    default:
      return assertNever(s); // a compile error as soon as Shape gains a member
  }
}
```

## Returning `err()` from `defineApi`

A [`defineApi`](/docs/typed-api) handler can return `err(code, init?)` instead of calling
`fail(code, init)`. The response is the same: the declared status, and the JSON error envelope
the client reads as an `ApiClientError`.

```ts
// app/api/posts/[id]/route.ts
import { defineApi } from "denext/server";
import { err } from "denext/result";
import { z } from "zod";

export const GET = defineApi({
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), title: z.string() }),
  errors: { not_found: 404, gone: { status: 410, message: "deleted" } },
}, async ({ params }) => {
  const post = await db.posts.get(params.id);
  if (!post) return err("not_found", { data: { id: params.id } });
  if (post.deletedAt) return err("gone");
  return post;
});
```

- The code must be one of the endpoint's `errors`. `err("typo")` is a compile error, even on
  an endpoint without a `response` schema.
- The second argument is the same `{ message?, data?, fieldErrors?, headers? }` that `fail()`
  takes.
- The returned `Err` is not part of the success type. `createApiClient` and `useApi` see the
  `response` body only, and `isApiClientError(e)` narrows `e.code` to the declared codes plus
  the built-in ones, exactly as with `fail()`.
- Only a value made by `err()` counts. A handler that returns an ordinary
  `{ ok: false, error: "…" }` object still sends it as a 200 JSON body.

## Returning `err()` from `defineAction`

A [`defineAction`](/docs/server-actions) handler can return `err(message, { fieldErrors })`
instead of throwing `ActionValidationError`. The action resolves to the same failed
`ActionResult`, and `useActionState` sees the success type without the `Err`:

```ts
// app/actions.ts
"use server";
import { defineAction } from "denext/server";
import { err } from "denext/result";

export const createPost = defineAction({
  input: (f) => ({ title: String(f.title ?? "").trim() }),
  handler: async ({ title }) => {
    if (!title) return err("Invalid post", { fieldErrors: { title: "Title is required" } });
    return { id: await db.posts.insert({ title }) }; // ActionResult<{ id: string }>
  },
});
```

The error must be a string message, and the details may carry only `fieldErrors`. Anything
else is a compile error. Like `ActionValidationError`, the message is meant for the user and is
not redacted in production. An unexpected throw from the handler is still redacted.

## Typed channel messages

`createChannel<Msg>` already accepts a discriminated union, and `useChannel` returns the latest
message typed as that union, so `match` covers the exhaustive handling:

```tsx
"use client";
import { useChannel } from "denext/live";
import { match } from "denext/result";
import { orderEvents } from "./live.ts"; // createChannel<OrderEvent>(…)

export function OrderStatus({ userId }: { userId: string }) {
  const { data } = useChannel(orderEvents, `user:${userId}`);
  if (!data) return null;
  return match(data)
    .with({ type: "shipped" }, (e) => <p>Shipped via {e.carrier}</p>)
    .with({ type: "delivered" }, () => <p>Delivered</p>)
    .with({ type: "cancelled" }, (e) => <p>Cancelled: {e.reason}</p>)
    .exhaustive();
}
```

There is no channel-specific handler helper. A channel delivers the latest message as state
(at-most-once, latest wins), not as an event stream, and `match` over that state already does
the job.

## Lint rules

denext's lint plugin has two opt-in rules for this style. They are not in the default plugin,
because both flag code that is correct by design in many apps. To enable them, export the
plugin from a module of your own and point `lint.plugins` at that module:

```ts
// lint/denext.ts
import { denextLintPlugin } from "jsr:@denext/denext/lint-plugin";

export default denextLintPlugin({
  exhaustiveSwitch: true,
  noThrow: { include: ["lib/domain", "app/api"] },
});
```

```json
// deno.json
{ "lint": { "plugins": ["./lint/denext.ts"] } }
```

The default rules (`rules-of-hooks` and the rest) are still included.

### `denext/exhaustive-switch`

A `switch` whose `case`s are all literals must handle every member of the discriminant's
union, or end in a `default`. The best `default` is `default: assertNever(x)`, which hands the
real check to the compiler.

Deno's lint plugins see syntax only. They have no type checker, so the rule's knowledge is
limited to what the file itself spells out:

- **Members known.** The discriminant is an identifier or `x.prop`, and its annotation in
  this file is a literal union, or a local `type` alias of one (for `x.prop`, a union of object
  types with a literal `prop`). The rule then names the missing members, for example
  `does not handle "rect"`.
- **Members unknown.** The type is imported, inferred, an enum, or annotated more than once in
  the file. The rule then asks for a `default` and suggests `assertNever`. It cannot tell an
  exhaustive switch from a non-exhaustive one, so it flags a switch over a plain `string` that
  deliberately ignores other values.
- **Any `default` passes.** A `default` that is not `assertNever` counts as a deliberate
  catch-all, the same as `.otherwise()`.
- **Mixed cases are skipped.** A switch with a non-literal `case` (`switch (true)`, a
  variable) is left alone.

### `denext/no-throw`

No `throw` statements in files under the directories you list. Directories are path segments
relative to the project (`"lib/domain"` matches `/repo/lib/domain/order.ts` but not
`/repo/lib/domainx/…`); there is no glob syntax. Return `err(...)` instead, or wrap a throwing
dependency in `tryAsync`. The rule checks `throw` statements only. It cannot see a call that
throws, and it does not exempt a `throw` that re-throws a caught error. Silence one line with
`// deno-lint-ignore denext/no-throw` where a throw is intended.
