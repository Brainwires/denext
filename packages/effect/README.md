# @denext/effect

First-class [Effect](https://effect.website) support for
[denext](https://jsr.io/@denext/denext). Run an `Effect` from a Server Component,
route handler, or Server Action and get **typed errors**, **dependency injection**
(services from a `Layer`), **structured concurrency**, and **client-disconnect
cancellation** — all wired into denext's per-request context.

Effect is distributed on npm (it is deliberately not published to JSR), so this
package depends on `npm:effect` as a peer. There is **no runtime to serve** — unlike
`@denext/htmx`, this is a set of runtime _bridges_, not a served asset.

## Install

```jsonc
// deno.json
{
  "imports": {
    "@denext/effect": "jsr:@denext/effect@^0.1.0",
    "effect": "npm:effect@^3.22.0"
  }
}
```

## Use it in a Server Component

Any async Server Component can `await runEffect(...)`. The `DenextRequest` service
resolves the live request from denext's per-request context — no prop-drilling.

```tsx
import { Effect } from "effect";
import { DenextRequest, runEffect } from "@denext/effect";

export default async function Page() {
  const auth = await runEffect(
    Effect.map(DenextRequest, (req) => req.request.headers.get("authorization")),
  );
  return <p>auth: {auth ?? "anonymous"}</p>;
}
```

## Typed errors, mapped to output

Use `runEffectExit` when you want to branch on a **typed failure** instead of a throw
— the natural fit for turning an error channel into rendered output, a response, or
form state.

```tsx
import { Cause, Effect, Exit } from "effect";
import { runEffectExit } from "@denext/effect";

const program = Effect.gen(function* () {
  const req = yield* DenextRequest;
  if (!req.request.headers.get("x-auth")) {
    return yield* Effect.fail({ _tag: "Unauthorized" } as const); // typed error
  }
  return "secret";
});

export default async function Page() {
  const exit = await runEffectExit(program);
  if (Exit.isSuccess(exit)) return <p>{exit.value}</p>;
  return <p>Denied.</p>;
}
```

## Dependency injection (services + layers)

Provide app-wide services once, then `yield*` them anywhere. Two ways:

### 1. The `effect()` plugin — ambient `runEffect`

```ts
// services.ts
import { Context, Effect, Layer } from "effect";
export class Db extends Context.Tag("app/Db")<Db, {
  userName: (id: string) => Effect.Effect<string>;
}>() {}
export const AppLayer = Layer.succeed(Db, {
  userName: (id) => Effect.succeed(`user#${id}`),
});
```

```ts
// denext.config.ts
import { effect } from "@denext/effect";
import { AppLayer } from "./services.ts";
export default { plugins: [effect({ layer: AppLayer })] };
```

The plugin builds the layer **once** (a memoized runtime — a database pool is
constructed a single time, not per request) and disposes it on shutdown, running every
`Layer`/`acquireRelease` finalizer. `runEffect` then resolves those services at run
time.

### 2. `createEffectRuntime(layer)` — fully typed

If you want the compiler to **check** that every service your Effects require is
provided, build a typed runner instead of relying on the ambient global:

```ts
// effect-runtime.ts
import { createEffectRuntime } from "@denext/effect";
import { AppLayer } from "./services.ts";
export const { runEffect, runEffectExit } = createEffectRuntime(AppLayer);
```

These `runEffect`/`runEffectExit` accept only Effects whose requirements are satisfied
by `AppLayer`, `DenextRequest`, or `Scope` — a missing service is a **compile error**.

## Route handlers and Server Actions

```ts
// app/api/user/route.ts
import { Effect } from "effect";
import { effectHandler } from "@denext/effect";

export const GET = effectHandler(
  () => Effect.succeed(Response.json({ ok: true })),
  { onError: (e) => Response.json({ error: e }, { status: 400 }) },
);
```

```ts
// app/actions.ts
"use server";
import { Effect } from "effect";
import { effectAction } from "@denext/effect";

// Resolves to { ok: true, value } | { ok: false, error } — pairs with useActionState.
export const subscribe = effectAction((email: string) =>
  email.includes("@") ? Effect.succeed({ email }) : Effect.fail({ _tag: "InvalidEmail" as const })
);
```

## How it works (and two things to know)

- **The request is provided per run, never memoized.** A `ManagedRuntime` memoizes its
  layers, so `DenextRequest` is layered on _each run_ via `Effect.provideService` (read
  from the ambient context) — putting it in the runtime's layer would capture one
  request and serve it to every later run.
- **The request's abort signal interrupts the run.** On client disconnect or timeout,
  the fiber is interrupted; thread the same `signal` into your `fetch()`es for
  cooperative cancellation downstream.
- **Every run is `Effect.scoped`.** Resources acquired with `acquireRelease` inside an
  Effect are released when that run completes.

## API

| Export                        | What it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `DenextRequest`               | Effect service (tag) yielding the live request, id, and abort signal. |
| `runEffect` / `runEffectExit` | Run on the ambient runtime → `Promise<A>` / `Promise<Exit<A, E>>`.    |
| `createEffectRuntime(layer)`  | A typed `EffectRunner` bound to an app layer (compile-checked reqs).  |
| `effect(options)`             | denext plugin: make an app layer ambient + manage its lifecycle.      |
| `effectHandler(fn, opts?)`    | Adapt an `Effect`-returning function into a route handler.            |
| `effectAction(fn)`            | Adapt an `Effect`-returning function into a Server Action.            |

## License

MIT
