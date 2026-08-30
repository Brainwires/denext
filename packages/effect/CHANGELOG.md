# Changelog

All notable changes to **@denext/effect** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-30

Initial release — [Effect](https://effect.website) bridges for denext.

### Added

- **`DenextRequest`** — an Effect service (`Context.GenericTag`) that yields the live
  request, its correlation id, and its abort signal from denext's per-request context.
  Provided **fresh per run** (never memoized), so each run is bound to the request
  actually being handled.
- **`runEffect` / `runEffectExit`** — run an Effect on the ambient runtime inside a
  request context, returning `Promise<A>` (rejects on failure) or `Promise<Exit<A, E>>`
  (branch on a typed failure without a throw). The request's abort signal interrupts
  the run, and every run is `Effect.scoped`.
- **`createEffectRuntime(layer)`** — build a **fully typed** `EffectRunner` from an app
  `Layer`; its `runEffect`/`runEffectExit` accept only Effects whose requirements are
  satisfied by the layer, `DenextRequest`, or `Scope`. The layer is memoized (built once,
  reused across requests).
- **`effect(options)`** — a denext plugin that makes an app `Layer` ambient for
  `runEffect` and disposes it (running `Layer`/`acquireRelease` finalizers) on shutdown.
- **`effectHandler(fn, options?)`** — adapt an `Effect`-returning function into a route
  handler: success `Response` passthrough, typed failure → `onError` (default 500),
  defect → 500.
- **`effectAction(fn)`** — adapt an `Effect`-returning function into a Server Action
  resolving to a serializable `ActionResult` (`{ ok: true, value } | { ok: false,
  error }`), pairing with `useActionState`.

### Notes

- Depends on `npm:effect` as a peer (Effect is not published to JSR).
- The public API is free of JSR "slow types": `DenextRequest` uses `Context.GenericTag`
  with an explicit annotation rather than the `class extends Context.Tag(...)` shorthand,
  which fast type-checking cannot infer.
