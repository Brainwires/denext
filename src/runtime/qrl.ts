// QRL — a lazily-loaded, code-split event handler with a stable identity.
//
// The resumability inverse of a server action. A server action serializes an id
// and, on the client, dispatches to the server by that id (the code stays on the
// server). A `qrl` serializes an id and, on the client, resolves that id to a
// dynamically-imported handler chunk (the code stays OFF the initial bundle and
// loads on first use). Both follow the same "reference without a closure" shape:
// serialize only the id, attach behavior lazily.
//
// Authoring (stage 2, no build transform yet — that is stage 4):
//
//   // handlers.ts  — a separate chunk
//   export function increment(e) { ... }
//
//   // counter.tsx  ("use client")
//   import { qrl } from "@denext/denext/client";
//   const onInc = qrl(() => import("./handlers.ts").then((m) => m.increment), "counter#increment");
//   <button onClick={onInc}>+</button>
//
// The handler's code is fetched only when the button is first activated. The id
// must be stable and app-unique so the server-serialized reference and the client
// loader agree across the boundary.

/** A handler invoked with a single event argument. */
type HandlerFn<E> = (event: E) => unknown;

/** A reference to a lazily-loaded handler: callable, tagged with its stable id. */
export interface Qrl<E = Event> {
  (event: E): Promise<void>;
  /** Stable id identifying this handler across the server/client boundary. */
  readonly denextQrlId: string;
}

// Map of qrl id → loader, populated when a `qrl(...)` runs. A serialized `{$:"e"}`
// reference resolves its handler through this map. On the server the loader is only
// stored (never invoked — handlers run on the client), so registering there is a
// harmless no-op bounded by the app's distinct handler ids. Lazily created so this
// module has no top-level side effect and tree-shakes out of apps that never qrl.
let registryStore: Map<string, () => Promise<HandlerFn<unknown>>> | null = null;
function registry(): Map<string, () => Promise<HandlerFn<unknown>>> {
  return (registryStore ??= new Map());
}

/**
 * Define a lazily-loaded event handler. Give it a **stable, explicit id** so the
 * server-serialized reference and the client loader agree.
 *
 * @param loader Imports and returns the handler implementation (put it in its own
 *   module so it code-splits, e.g. `() => import("./h.ts").then((m) => m.onClick)`).
 * @param id A stable, app-unique identifier for this handler.
 * @returns A callable {@link Qrl} usable directly as an event-handler prop.
 */
export function qrl<E = Event>(
  loader: () => Promise<(event: E) => unknown>,
  id: string,
): Qrl<E> {
  registry().set(id, loader as () => Promise<HandlerFn<unknown>>);
  const ref = async (event: E): Promise<void> => {
    const fn = await loader();
    await fn(event);
  };
  return Object.assign(ref, { denextQrlId: id }) as Qrl<E>;
}

/** True if `value` is a {@link Qrl} reference (callable tagged with `denextQrlId`). */
export function isQrl(value: unknown): value is Qrl {
  return typeof value === "function" &&
    typeof (value as { denextQrlId?: unknown }).denextQrlId === "string";
}

/**
 * Rehydrate a serialized `{$:"e"}` handler reference into a callable that, on
 * invocation, resolves the registered loader for `id` and runs it. Used by the
 * Flight client; the loader is registered when the owning component's `qrl(...)`
 * runs in the browser, so a click that arrives after that resolves correctly.
 *
 * @param id The handler's stable id.
 */
export function qrlStub<E = Event>(id: string): Qrl<E> {
  const ref = async (event: E): Promise<void> => {
    const loader = registry().get(id);
    if (!loader) {
      console.warn("denext: no qrl registered for", id);
      return;
    }
    const fn = await loader();
    await fn(event as unknown);
  };
  return Object.assign(ref, { denextQrlId: id }) as Qrl<E>;
}

/** The registered loader for `id`, if any (used by lazy-attach). */
export function getQrlLoader(id: string): (() => Promise<HandlerFn<unknown>>) | undefined {
  return registry().get(id);
}
