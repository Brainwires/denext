// Server Actions — call a server function from the client over an RPC endpoint.
import { djb2 } from "./djb2.ts";
import { detachedFromRequest } from "./root-context-bridge.ts";
import { isChannel, registerChannelIfLoaded } from "./channel-brand.ts";
import { decodeWire, WIRE_ENC } from "./wire-codec.ts";
import type { ResolvedRestart } from "./restart.ts";
import { processShared } from "./process-shared.ts";
//
// denext has no bundler transform of `"use server"`, so actions are registered
// at runtime by id: `serverAction("id", handler)`. On the server the returned
// reference runs the handler directly (and registers it for dispatch); in the
// browser it returns a stub that POSTs to `/_denext/action/<id>`.
//
// SECURITY: the dispatch endpoint runs with the visitor's ambient cookies, so it
// is a CSRF target. The server enforces same-origin on every action request
// (see `handleAction`). Actions themselves must still perform their own
// authorization and input validation — being registered makes an action
// callable by anyone who is same-origin.

/** The reserved URL prefix under which server actions are dispatched. */
export const ACTION_PREFIX = "/_denext/action/";

/** A reference to a server action: callable, and tagged with its stable id. */
export interface ServerActionRef<A extends unknown[], R> {
  (...args: A): Promise<R>;
  /** Stable id identifying this action across the server/client boundary. */
  readonly denextActionId: string;
}

type ActionHandler = (...args: unknown[]) => unknown;

// Registry of server-side handlers, keyed by id. Populated only on the server
// (when a module calls serverAction during import/render); unused in the browser.
const registry = /* @__PURE__ */ processShared(
  "serverActions",
  () => new Map<string, ActionHandler>(),
);

// Dev: each platform target's own registrations (`tagServerModules`' `scope`). A target's loader
// yields its own module instances (its platform files), so the same action id runs another
// implementation per target. Production registers globally only.
const scopedRegistries = /* @__PURE__ */ processShared(
  "scopedServerActions",
  () => new Map<string, Map<string, ActionHandler>>(),
);

/** The registry `scope` registers into: the global one for `""`. */
function registryFor(scope: string): Map<string, ActionHandler> {
  if (!scope) return registry;
  let scoped = scopedRegistries.get(scope);
  if (!scoped) scopedRegistries.set(scope, scoped = new Map());
  return scoped;
}

/** The process's mutable server-action settings, shared by every copy of this module. */
const shared = /* @__PURE__ */ processShared("serverActionState", () => ({
  // Server-only: gives each server reference a `bind` that keeps it one (installed by
  // src/server/action-bound.ts, which seals the bound values; never set in the browser).
  decorateReference: null as ((fn: ActionHandler, id: string) => void) | null,
  // Bumped by forgetTaggedServers: a tagging pass that started before the bump must not mark its
  // (possibly pre-edit) module tagged after the set was cleared.
  serverTagGeneration: 0,
}));

/**
 * Register a handler as a server reference under `id` and return a callable ref
 * tagged with that id. The building block behind `serverAction` (action-stub.ts) and the
 * auto-registration of `"use server"` module exports.
 *
 * @param id The stable server-reference id.
 * @param handler The server-side implementation.
 * @returns A {@link ServerActionRef} that runs the handler directly.
 */
export function registerServerReference<A extends unknown[], R>(
  id: string,
  handler: (...args: A) => R | Promise<R>,
): ServerActionRef<A, R> {
  registry.set(id, handler as (...args: unknown[]) => unknown);
  const ref = (...args: A) => Promise.resolve(handler(...args));
  shared.decorateReference?.(ref as unknown as ActionHandler, id);
  return Object.assign(ref, { denextActionId: id }) as ServerActionRef<A, R>;
}

/**
 * Remove the handler registered under `id` from the global registry (an inline action re-registered
 * as bound-only, src/server/action-bound.ts, must not stay callable by its plain id).
 *
 * @param id The server-reference id.
 */
export function unregisterServerReference(id: string): void {
  registry.delete(id);
}

/**
 * Install the server's server-reference decorator (src/server/action-bound.ts): every reference
 * {@linkcode registerServerReference} creates or {@linkcode tagServerExports} tags afterwards
 * passes through it.
 *
 * @param decorate Called with each reference and its id.
 */
export function setServerReferenceDecorator(
  decorate: (fn: ActionHandler, id: string) => void,
): void {
  shared.decorateReference = decorate;
}

/** Readable `module#export` names behind the opaque ids (dev diagnostics only). */
const actionNames = /* @__PURE__ */ processShared("actionNames", () => new Map<string, string>());

/**
 * The opaque, build-stable id of an exported server function: a hash of
 * `moduleId#exportName`, so the wire id does not spell out the module path and export
 * name (an enumeration aid) while staying identical across processes and replicas.
 */
export function actionIdFor(moduleId: string, exportName: string): string {
  const key = `${moduleId}#${exportName}`;
  const id = `a${djb2(key)}${djb2([...key].reverse().join(""))}`;
  actionNames.set(id, key);
  return id;
}

/** The `module#export` an opaque action id was minted for (dev diagnostics), if known. */
export function describeActionId(id: string): string | undefined {
  return actionNames.get(id);
}

/**
 * Auto-register every function exported by a `"use server"` module as a server
 * reference, tagging each exported function in place (so it serializes as an
 * action reference when passed as a prop, e.g. `<form action={save}>`). Ids are
 * opaque hashes of `moduleId#exportName` (see {@linkcode actionIdFor}). Idempotent per
 * function; a function already tagged with its id is registered again (into another scope, or
 * over a previous instance of the module).
 *
 * @param mod The imported `"use server"` module namespace.
 * @param moduleId The module's stable id.
 * @param scope The registry to register into (dev: a platform target's); `""` is the global one.
 */
export function tagServerExports(
  mod: Record<string, unknown>,
  moduleId: string,
  scope = "",
): void {
  for (const [name, value] of Object.entries(mod)) {
    // A `createChannel` export (an object, not a function): assign its id and register it.
    // It is NOT an action — a channel is never HTTP-callable, only subscribed to.
    if (isChannel(value)) {
      if (!value.denextChannelId) registerChannelIfLoaded(actionIdFor(moduleId, name), value);
      continue;
    }
    if (typeof value !== "function") continue;
    const id = actionIdFor(moduleId, name);
    // A `serverAction("id", fn)` ref (or one re-exported from another module) keeps its own id.
    const tagged = (value as { denextActionId?: unknown }).denextActionId;
    if (tagged !== undefined && tagged !== id) continue;
    registryFor(scope).set(id, value as ActionHandler);
    if (tagged !== undefined) continue;
    Object.defineProperty(value, "denextActionId", {
      value: id,
      enumerable: false,
      configurable: true,
    });
    shared.decorateReference?.(value as ActionHandler, id);
    // A `defineSubscription` export: its definition is registered (and made live-readable).
    const def = (value as { [SUBSCRIPTION_DEF]?: SubscriptionDef })[SUBSCRIPTION_DEF];
    if (def) registerSubscription(id, def);
  }
}

/**
 * A browser reference to the Server Action `id`: a callable that hands each call to `call`,
 * tagged with `denextActionId` so it round-trips (e.g. when re-serialized as a `<form action>`).
 * The two stubs build on it — the Flight client's (src/client/flight-client.ts) and the generic
 * `clientActionStub` (action-stub.ts) — each with its own on-demand dispatch, so neither puts the
 * dispatch or the wire encoder in a page's startup chunks.
 *
 * @param id The server-reference / action id.
 * @param call Performs the call (loads the dispatch, POSTs, resolves with the result).
 * @returns The reference.
 */
export function actionReference<A extends unknown[], R>(
  id: string,
  call: (id: string, args: unknown[]) => Promise<unknown>,
): ServerActionRef<A, R> {
  const ref = (...args: A) => call(id, args) as Promise<R>;
  return Object.assign(ref, { denextActionId: id }) as ServerActionRef<A, R>;
}

// Server module ids already imported + tagged this process (per scope).
const taggedServers = /* @__PURE__ */ processShared("taggedServers", () => new Set<string>());
/**
 * Import each `"use server"` module and auto-register its exports as server
 * references (see {@link tagServerExports}). Safe to call repeatedly; each module
 * is imported at most once per process and scope (until {@linkcode forgetTaggedServers}).
 *
 * @param servers Map of module id → `{ url }` (the boundary manifest's servers).
 * @param load The loader to import each module through (default: a bare `import()`).
 * @param scope The registry to register into: dev passes a platform target, whose loader yields
 *   its own module instances; `""` (production) is the global registry.
 */
export async function tagServerModules(
  servers: Iterable<[string, { url: string }]>,
  load?: (url: string) => Promise<unknown>,
  scope = "",
): Promise<void> {
  const key = (moduleId: string) => scope ? `${scope}\0${moduleId}` : moduleId;
  const generation = shared.serverTagGeneration;
  // Every module is tagged even when another fails to load: one broken module must not leave
  // the rest unregistered. The first failure is rethrown once all have settled.
  const results = await Promise.allSettled(
    [...servers].map(async ([moduleId, ref]) => {
      if (taggedServers.has(key(moduleId))) return;
      const mod = load ? await load(ref.url) : await detachedFromRequest(() => import(ref.url));
      tagServerExports(mod as Record<string, unknown>, moduleId, scope);
      // `forgetTaggedServers` ran while this module loaded: what loaded may be the pre-edit
      // instance, so leave it untagged and let the next pass load the current one.
      if (generation === shared.serverTagGeneration) taggedServers.add(key(moduleId));
    }),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * Dev: forget which modules were tagged, so the next {@linkcode tagServerModules} loads them
 * again and registers an edited module's new implementation (an unchanged one loads the same
 * instance and registers the same functions).
 */
export function forgetTaggedServers(): void {
  shared.serverTagGeneration++;
  taggedServers.clear();
}

/**
 * Look up a registered server action handler by id (server-side).
 *
 * @param id The action id.
 * @param scope Dev: the requesting target's registry, consulted before the global one.
 */
export function getServerAction(id: string, scope = ""): ActionHandler | undefined {
  return (scope ? scopedRegistries.get(scope)?.get(id) : undefined) ?? registry.get(id);
}

// Action ids explicitly opted in to invocation over the Live WebSocket channel
// (`useLive`). Empty by default: an action is HTTP-dispatchable when registered,
// but not live-readable until marked — so the persistent socket can't be used to
// run arbitrary registered actions. The Live hub also accepts a `canSubscribe`
// policy as an alternative gate (see `installLiveHub`).
const liveReadableIds = /* @__PURE__ */ processShared("liveReadableIds", () => new Set<string>());

/**
 * Mark a server action as readable over the Live data channel (`useLive`), and
 * return it unchanged for chaining. Only actions marked here — or admitted by the
 * Live hub's `canSubscribe` policy — may be run via a `data-subscribe`. Use it for
 * read-only fetchers you intend to stream; never for mutations.
 *
 * @param action A {@link ServerActionRef} (or any value carrying `denextActionId`).
 * @returns The same `action`, now flagged live-readable.
 */
export function liveReadable<T extends { denextActionId: string }>(action: T): T {
  liveReadableIds.add(action.denextActionId);
  return action;
}

/** True if `id` was opted in via {@link liveReadable} (server-side). */
export function isLiveReadable(id: string): boolean {
  return liveReadableIds.has(id);
}

// ── Subscription definitions (`defineSubscription`) ──────────────────────────

/** What a subscription's `authorize` / `resolve` receive besides the parsed input. */
export interface SubscriptionRunContext {
  /** The Live connection's identity over the socket; `null` on the one-shot path. */
  connection: { origin: string; url: string; cookie: string; peerId: string } | null;
  /** The recompute deadline (Live) or the request's signal. */
  signal?: AbortSignal;
}

/** The hub-facing half of a `defineSubscription`: validate, gate, compute. */
export interface SubscriptionDef {
  /** Validate the client's raw input; returns the parsed input and the server-derived tags. */
  parse(input: unknown): Promise<{ parsed: unknown; tags: string[] }>;
  /** Row-level gate, re-run on every recompute. */
  authorize?: (parsed: unknown, ctx: SubscriptionRunContext) => Promise<boolean>;
  /** Compute the value. */
  run(parsed: unknown, ctx: SubscriptionRunContext): Promise<unknown>;
  /** Restart a recompute whose `run` threw (the `restart` option), when set. */
  restart?: ResolvedRestart;
}

/** The symbol under which a `defineSubscription` ref carries its {@link SubscriptionDef}. */
export const SUBSCRIPTION_DEF: unique symbol = /* @__PURE__ */ Symbol.for(
  "denext.subscriptionDef",
) as never;

const subscriptionDefs = /* @__PURE__ */ processShared(
  "subscriptionDefs",
  () => new Map<string, SubscriptionDef>(),
);

/**
 * Register a subscription definition under `id`. Registering IS the live opt-in: a definition
 * exists only to be subscribed to, and it validates and gates its own input.
 *
 * @param id The server-reference id.
 * @param def The definition.
 */
export function registerSubscription(id: string, def: SubscriptionDef): void {
  subscriptionDefs.set(id, def);
  liveReadableIds.add(id);
}

/**
 * The subscription definition registered under `id`, if any.
 *
 * @param id The server-reference id.
 * @returns The definition, or `undefined` for a plain action.
 */
export function getSubscriptionDef(id: string): SubscriptionDef | undefined {
  return subscriptionDefs.get(id);
}

/** The dispatch URL for an action id. */
export function actionEndpoint(id: string): string {
  return ACTION_PREFIX + encodeURIComponent(id);
}

/** True if `value` is a {@link ServerActionRef}. */
export function isServerAction(
  value: unknown,
): value is ServerActionRef<unknown[], unknown> {
  return (
    typeof value === "function" &&
    typeof (value as { denextActionId?: unknown }).denextActionId === "string"
  );
}

/**
 * Reserved FormData field carrying non-FormData args alongside a FormData arg (the client's
 * encoder, src/client/action-dispatch.ts, writes the same name).
 */
const META_FIELD = "__denext_meta";

// ---- Client dispatch -------------------------------------------------------

// After an action's XHR response reports that it revalidated tags or requested a
// refresh, the client re-fetches and re-renders the current route so the UI
// reflects the server's new state (Next.js read-your-writes / refresh semantics).
// The handler is registered by the client runtime at boot (`startClient` →
// `setActionRefreshHandler`) — a seam so this isomorphic module never links client
// navigation into the server graph. Left null on the server / before boot. Handed to the
// dispatch with each call.
let onActionRefresh: (() => void) | null = null;

/**
 * Register the post-action refresh handler. Called once by the client runtime at
 * boot with a closure that re-renders the current route. When a server action
 * reports `refresh`/`updatedTags`, the client dispatch invokes it so the
 * client reflects the mutation without a full page reload.
 */
export function setActionRefreshHandler(refresh: () => void): void {
  onActionRefresh = refresh;
}

/**
 * The post-action refresh handler {@linkcode setActionRefreshHandler} registered, handed to the
 * client dispatch with each call.
 *
 * @returns The handler, or `null` (the server, or before the client booted).
 */
export function actionRefreshHandler(): (() => void) | null {
  return onActionRefresh;
}

/** Un-envelope a codec-flagged field (`enc: 1`); a plain field is returned as-is. */
function decodeEnvelope(env: { enc?: unknown }, value: unknown): unknown {
  return env.enc === WIRE_ENC ? decodeWire(value) : value;
}

/**
 * Decode action arguments from a request body (mirror of the client's `encodeActionArgs`,
 * src/client/action-dispatch.ts).
 * A native (no-JS) form post with no meta field yields a single `FormData` arg.
 *
 * @param request The incoming action request.
 * @returns The argument list to apply to the handler.
 */
export async function decodeActionArgs(request: Request): Promise<unknown[]> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { args?: unknown; enc?: unknown };
    // A malformed codec payload throws (WireCodecError) → the action handler's 400.
    const args = decodeEnvelope(body, body.args);
    return Array.isArray(args) ? args : [];
  }
  const fd = await request.formData();
  const metaRaw = fd.get(META_FIELD);
  if (typeof metaRaw === "string") {
    fd.delete(META_FIELD);
    let meta: { fdIndex: number; others: unknown[]; enc?: unknown };
    try {
      meta = JSON.parse(metaRaw);
      meta.others = decodeEnvelope(meta, meta.others) as unknown[];
    } catch {
      return [fd];
    }
    // `fdIndex` is attacker-controlled. It must name a real in-range slot of
    // `others`; otherwise `args[fdIndex] = fd` could inflate the array to an
    // arbitrary length, and the handler spread (`handler(...args)`) would then
    // iterate every hole — an unbounded-work DoS (CVE-2026-64641 / CWE-834 class).
    // Reject anything but a valid index and fall back to treating the request as a
    // native single-FormData submission.
    if (
      !Array.isArray(meta.others) ||
      !Number.isInteger(meta.fdIndex) ||
      meta.fdIndex < 0 ||
      meta.fdIndex >= meta.others.length
    ) {
      return [fd];
    }
    const args = [...meta.others];
    args[meta.fdIndex] = fd;
    return args;
  }
  // Native progressive-enhancement post: the raw form is the single argument.
  return [fd];
}
