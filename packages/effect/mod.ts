/**
 * `@denext/effect` — first-class {@link https://effect.website | Effect} support for
 * {@link https://jsr.io/@denext/denext | denext}. Run an `Effect` from a Server
 * Component, route handler, or Server Action and get **typed errors**, **dependency
 * injection** (services provided by a `Layer`), **structured concurrency**, and
 * **client-disconnect cancellation** — all wired into denext's per-request context.
 *
 * Effect is distributed on npm (it is deliberately not published to JSR), so this
 * package depends on `npm:effect` as a peer; there is no runtime to serve (unlike
 * `@denext/htmx`) — it is a set of runtime **bridges**, not a served asset.
 *
 * ```tsx
 * // app/user/[id]/page.tsx — a Server Component awaits an Effect
 * import { Effect } from "effect";
 * import { DenextRequest, runEffect } from "@denext/effect";
 * import { Db } from "../../services.ts";
 *
 * export default async function User({ params }: { params: { id: string } }) {
 *   const name = await runEffect(Effect.gen(function* () {
 *     const req = yield* DenextRequest;            // request-scoped service
 *     const db = yield* Db;                        // app-wide service (from a Layer)
 *     if (!req.request.headers.get("x-auth")) {
 *       return yield* Effect.fail({ _tag: "Unauthorized" } as const); // typed error
 *     }
 *     return yield* db.userName(params.id);
 *   }));
 *   return <h1>{name}</h1>;
 * }
 * ```
 *
 * Provide app-wide services once — either with the {@linkcode effect} plugin in
 * `denext.config.ts` (ambient {@linkcode runEffect}) or with the typed
 * {@linkcode createEffectRuntime} factory (fully type-checked requirements).
 *
 * @module
 */

import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, type Scope } from "effect";
import { currentContext } from "@denext/denext/server";
import type { DenextPlugin, PluginContext } from "@denext/denext/plugin-kit";

// Re-export the denext plugin types referenced by this package's public API so the
// generated docs are self-contained (deno doc --lint requires every type used in a
// public signature to be exported from an entrypoint). Type-only; no runtime effect.
export type { DenextPlugin, PluginContext } from "@denext/denext/plugin-kit";

/**
 * The request-scoped service exposed by {@linkcode DenextRequest}: the live incoming
 * request, its correlation id, and its abort signal. Backed by denext's per-request
 * context, so any Effect run via {@linkcode runEffect} sees the request currently
 * being handled — no prop-drilling.
 */
export interface DenextRequestService {
  /** The incoming request being handled. */
  readonly request: Request;
  /** This request's correlation id (matches the server log / `x-request-id`). */
  readonly requestId: string;
  /**
   * The request's abort signal — fires on client disconnect or timeout. Passed to
   * the Effect runtime as the run's interrupt signal, so a disconnect interrupts the
   * fiber; thread it into your own `fetch()`es for cooperative cancellation too.
   */
  readonly signal?: AbortSignal;
}

/**
 * The requirement (identifier) type of the {@linkcode DenextRequest} service tag —
 * structurally the {@linkcode DenextRequestService}, under a distinct name so an
 * Effect's requirements read as `DenextRequest`.
 */
export interface DenextRequest extends DenextRequestService {}

/**
 * An Effect {@link https://effect.website/docs/requirements-management/services/ | service}
 * (a `Context.Tag`) that yields the current denext request as a
 * {@linkcode DenextRequestService}. `yield* DenextRequest` inside any Effect run by
 * this package resolves it from the ambient request context.
 *
 * Defined with `Context.GenericTag` and an explicit type annotation (rather than the
 * `class extends Context.Tag(...)` shorthand) so the package is free of JSR "slow
 * types" — fast type-checking cannot infer the computed-superclass form.
 *
 * ```ts
 * const auth = Effect.gen(function* () {
 *   const { request } = yield* DenextRequest;
 *   return request.headers.get("authorization");
 * });
 * ```
 */
export const DenextRequest: Context.Tag<DenextRequest, DenextRequestService> = Context
  .GenericTag<DenextRequest, DenextRequestService>("denext/DenextRequest");

/** Read the current request as a {@linkcode DenextRequestService} (throws if none). */
function requestService(): DenextRequestService {
  const ctx = currentContext();
  if (!ctx) {
    throw new Error(
      "@denext/effect: no active denext request context. Run an Effect inside a " +
        "server component, route handler, or Server Action (or wrap the call in " +
        "the request pipeline).",
    );
  }
  return { request: ctx.request, requestId: ctx.requestId, signal: ctx.signal };
}

/**
 * Provide {@linkcode DenextRequest} to `effect` **fresh, at run time** — read from the
 * ambient context each run, never memoized. This is deliberate: a `ManagedRuntime`
 * memoizes its layers, so putting the request in the runtime's layer would capture one
 * request and serve it to every later run (a cross-request leak). Providing it per run
 * keeps each run bound to the request actually being handled.
 */
function provideRequest<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, DenextRequest>> {
  return Effect.suspend(() => Effect.provideService(effect, DenextRequest, requestService()));
}

/**
 * The requirements an Effect may declare and still be runnable by this package:
 * whatever the app `Layer` provides (`RApp`), plus the always-available
 * {@linkcode DenextRequest} and a `Scope` (so `Effect.acquireRelease` resources are
 * released when the run completes).
 */
export type Runnable<RApp> = RApp | DenextRequest | Scope.Scope;

/** A managed Effect runtime bound to an app layer (see {@linkcode createEffectRuntime}). */
export type EffectRuntime<RApp = never, E = never> = ManagedRuntime.ManagedRuntime<RApp, E>;

/**
 * A pair of runners bound to a specific app {@linkcode EffectRuntime}, returned by
 * {@linkcode createEffectRuntime}. Unlike the ambient {@linkcode runEffect}, these are
 * **fully typed**: the compiler checks that every service an Effect requires is either
 * provided by the runtime's layer or is {@linkcode DenextRequest}/`Scope`.
 */
export interface EffectRunner<RApp, EApp = never> {
  /**
   * Run an Effect to a `Promise`, providing this runner's services + the request
   * context. Rejects if the Effect fails (the failure's error is thrown) or dies.
   * The current request's abort signal interrupts the run.
   */
  runEffect<A, E>(effect: Effect.Effect<A, E, Runnable<RApp>>): Promise<A>;
  /**
   * Run an Effect to an `Exit`, so the caller can branch on a **typed failure**
   * without a throw (the natural fit for mapping errors to responses / form state).
   * The error type includes `EApp` — the app layer's own construction error, if any.
   */
  runEffectExit<A, E>(
    effect: Effect.Effect<A, E, Runnable<RApp>>,
  ): Promise<Exit.Exit<A, E | EApp>>;
  /** The underlying managed runtime (memoizes the layer; build it once, reuse it). */
  readonly runtime: EffectRuntime<RApp, EApp>;
  /** Dispose the runtime, running every `Layer`/`acquireRelease` finalizer. */
  dispose(): Promise<void>;
}

/** Provide the current request's abort signal as the Effect run's interrupt signal. */
function runSignal(): { signal?: AbortSignal } {
  const ctx = currentContext();
  return ctx?.signal ? { signal: ctx.signal } : {};
}

/**
 * Build a typed {@linkcode EffectRunner} from an app `Layer`. Prefer this over the
 * ambient {@linkcode runEffect} when you want the compiler to verify that every
 * service your Effects require is provided — the returned `runEffect`/`runEffectExit`
 * accept only Effects whose requirements are satisfied by `layer`,
 * {@linkcode DenextRequest}, or `Scope`.
 *
 * The runtime memoizes the layer (a database pool, a client, etc. is constructed
 * once, not per request), so build it once at module load and reuse it. Call
 * {@linkcode EffectRunner.dispose} on shutdown to release resources — or register the
 * {@linkcode effect} plugin instead, which does this for the ambient runtime.
 *
 * ```ts
 * // effect-runtime.ts
 * import { createEffectRuntime } from "@denext/effect";
 * import { AppLayer } from "./services.ts";
 * export const { runEffect, runEffectExit } = createEffectRuntime(AppLayer);
 * ```
 *
 * @param layer The app layer providing your services (its requirements must be `never`).
 */
export function createEffectRuntime<RApp, EApp>(
  layer: Layer.Layer<RApp, EApp, never>,
): EffectRunner<RApp, EApp> {
  const runtime = ManagedRuntime.make(layer);
  return {
    runEffect: (effect) => runtime.runPromise(Effect.scoped(provideRequest(effect)), runSignal()),
    runEffectExit: (effect) =>
      runtime.runPromiseExit(Effect.scoped(provideRequest(effect)), runSignal()),
    runtime,
    dispose: () => runtime.dispose(),
  };
}

// The ambient runtime used by the module-level `runEffect`/`runEffectExit`. Set by the
// `effect()` plugin (with the app layer); lazily created request-only if the plugin is
// absent, so the ambient runners always work even without configuration.
// The ambient runners erase the app layer's services from their public types (the
// documented convenience tradeoff vs. `createEffectRuntime`), so the ambient runtime is
// stored and used loosely. `Layer`'s variance makes the empty and plugin layers fight a
// precisely-typed slot, so bridge through `unknown` at the (only two) build sites.
// deno-lint-ignore no-explicit-any
type LooseRuntime = ManagedRuntime.ManagedRuntime<any, any>;

let ambientRuntime: LooseRuntime | null = null;

function getAmbient(): LooseRuntime {
  return (ambientRuntime ??= ManagedRuntime.make(Layer.empty) as unknown as LooseRuntime);
}

/**
 * Run an Effect using the **ambient** runtime (configured by the {@linkcode effect}
 * plugin, or request-only if no plugin is registered) and return its result as a
 * `Promise`. Rejects on failure or defect; the current request's abort signal
 * interrupts the run.
 *
 * This is the convenience path: it accepts any Effect requiring only
 * {@linkcode DenextRequest}/`Scope` at the type level. App services provided by the
 * plugin's layer are available at run time but are **not** reflected in the type — for
 * compile-time-checked requirements, use {@linkcode createEffectRuntime} instead.
 *
 * @param effect The Effect to run (inside a denext request context).
 */
export function runEffect<A, E>(
  effect: Effect.Effect<A, E, DenextRequest | Scope.Scope>,
): Promise<A> {
  return getAmbient().runPromise(Effect.scoped(provideRequest(effect)), runSignal());
}

/**
 * Like {@linkcode runEffect}, but returns an `Exit` so the caller can branch on a
 * **typed failure** without a throw — the natural way to map an Effect's error channel
 * onto a response or form state.
 *
 * @param effect The Effect to run (inside a denext request context).
 */
export function runEffectExit<A, E>(
  effect: Effect.Effect<A, E, DenextRequest | Scope.Scope>,
): Promise<Exit.Exit<A, E>> {
  return getAmbient().runPromiseExit(Effect.scoped(provideRequest(effect)), runSignal());
}

/** Options for the {@linkcode effect} plugin. */
export interface EffectPluginOptions {
  /**
   * An app `Layer` providing the services your Effects require (its requirements must
   * be `never`). The plugin builds a memoized runtime from it and disposes it on
   * shutdown; the ambient {@linkcode runEffect}/{@linkcode runEffectExit} then resolve
   * those services at run time.
   */
  // deno-lint-ignore no-explicit-any
  layer?: Layer.Layer<any, any, never>;
}

/**
 * The denext plugin that wires an app `Layer` into the ambient {@linkcode runEffect}.
 * Add it to `denext.config.ts`; its layer's services then resolve inside any ambient
 * run, and its resources are disposed when the server drains.
 *
 * ```ts
 * // denext.config.ts
 * import { effect } from "@denext/effect";
 * import { AppLayer } from "./services.ts";
 * export default { plugins: [effect({ layer: AppLayer })] };
 * ```
 *
 * The plugin is optional: without it, {@linkcode runEffect} still works with just the
 * request-scoped {@linkcode DenextRequest}. Its only job is to make app services
 * ambient and to manage their lifecycle.
 *
 * @param options The app layer to provide (see {@linkcode EffectPluginOptions}).
 */
export function effect(options: EffectPluginOptions = {}): DenextPlugin {
  return {
    name: "@denext/effect",
    setup(ctx: PluginContext) {
      ambientRuntime = ManagedRuntime.make(options.layer ?? Layer.empty) as unknown as LooseRuntime;
      ctx.addTeardown(async () => {
        const rt = ambientRuntime;
        ambientRuntime = null;
        if (rt) await rt.dispose();
      });
    },
  };
}

/** Options for {@linkcode effectHandler}. */
export interface EffectHandlerOptions<E> {
  /**
   * Map a **typed failure** to a `Response`. Called when the Effect fails in its error
   * channel (not on an unexpected defect). Without it, a failure becomes a 500.
   */
  onError?: (error: E) => Response | Promise<Response>;
}

/**
 * Adapt an Effect-returning function into a denext route-handler function. The Effect
 * runs on the ambient runtime inside the request context; a success `Response` is
 * returned as-is, a typed failure is mapped by {@linkcode EffectHandlerOptions.onError}
 * (default: 500), and an unexpected defect logs and returns 500.
 *
 * ```ts
 * // app/api/user/route.ts
 * import { Effect } from "effect";
 * import { effectHandler } from "@denext/effect";
 *
 * export const GET = effectHandler(
 *   (req) => Effect.succeed(Response.json({ ok: true })),
 *   { onError: (e) => Response.json({ error: e }, { status: 400 }) },
 * );
 * ```
 *
 * @param fn Builds the Effect for a request (may require {@linkcode DenextRequest}/`Scope`).
 * @param options Error mapping (see {@linkcode EffectHandlerOptions}).
 */
export function effectHandler<E>(
  fn: (request: Request) => Effect.Effect<Response, E, DenextRequest | Scope.Scope>,
  options: EffectHandlerOptions<E> = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const exit = await runEffectExit(fn(request));
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some" && options.onError) {
      return await options.onError(failure.value);
    }
    console.error(
      "@denext/effect: route handler failed:\n" + Cause.pretty(exit.cause),
    );
    return new Response("Internal Server Error", { status: 500 });
  };
}

/**
 * A serializable result from an {@linkcode effectAction}: a success value, or a
 * **typed error** carried in the error channel. Pairs with `useActionState` — the
 * error is a plain value your form can render, not a thrown exception.
 */
export type ActionResult<A, E> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

/**
 * Adapt an Effect-returning function into a Server Action that resolves to a
 * serializable {@linkcode ActionResult}. A typed failure becomes `{ ok: false, error }`
 * (the direct fit for `useActionState` — the form renders the error); an unexpected
 * defect is rethrown (it is a bug, not an expected outcome).
 *
 * ```ts
 * // app/actions.ts
 * "use server";
 * import { Effect } from "effect";
 * import { effectAction } from "@denext/effect";
 *
 * export const subscribe = effectAction((email: string) =>
 *   email.includes("@")
 *     ? Effect.succeed({ subscribed: email })
 *     : Effect.fail({ _tag: "InvalidEmail" as const })
 * );
 * ```
 *
 * @param fn Builds the Effect for the action's arguments.
 */
export function effectAction<Args extends readonly unknown[], A, E>(
  fn: (...args: Args) => Effect.Effect<A, E, DenextRequest | Scope.Scope>,
): (...args: Args) => Promise<ActionResult<A, E>> {
  return async (...args: Args): Promise<ActionResult<A, E>> => {
    const exit = await runEffectExit(fn(...args));
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") return { ok: false, error: failure.value };
    throw new Error("@denext/effect: Server Action defect:\n" + Cause.pretty(exit.cause));
  };
}
