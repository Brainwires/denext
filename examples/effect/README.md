# denext + Effect example

A minimal App Router app that runs [Effect](https://effect.website) inside a
Server Component via [`@denext/effect`](../../packages/effect), showing:

- **request-scoped DI** — the `DenextRequest` service reads the live `?id=`
  query;
- **app-wide DI** — a `Users` service provided once by `AppLayer`, wired into a
  typed runtime with `createEffectRuntime` (`effect-runtime.ts`) so the page's
  `runEffectExit` is fully type-checked (a missing service is a compile error);
- **typed errors** — `users.nameOf` fails with `UserNotFound`, and the page
  branches on the `Exit` instead of catching a throw.

> This example uses the typed `createEffectRuntime` path. For the ambient
> `runEffect` + `effect()` plugin variant, see the package README.

## Run

```sh
deno task dev     # http://localhost:8000
```

Then try `/?id=1`, `/?id=2`, `/?id=3` (success) or `/?id=9` (the typed-error
branch).

## Files

- `services.ts` — the `Users` service, its typed `UserNotFound` error, and
  `AppLayer`.
- `effect-runtime.ts` — `createEffectRuntime(AppLayer)` → typed
  `runEffect`/`runEffectExit`.
- `app/page.tsx` — a Server Component that `await`s `runEffectExit(...)`.
