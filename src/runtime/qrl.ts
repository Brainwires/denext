// QRL — a lazily-loaded, code-split event handler with a stable identity.
//
// The resumability inverse of a server action. A server action serializes an id
// and, on the client, dispatches to the server by that id (the code stays on the
// server). A `qrl` serializes an id and, on the client, resolves that id to a
// dynamically-imported handler chunk (the code stays OFF the initial bundle and
// loads on first use). Both follow the same "reference without a closure" shape:
// serialize only the id, attach behavior lazily.
//
// Authoring: in a `resumable` route the build transform (`src/build/qrl-transform.ts`)
// auto-wraps inline handlers, so you write plain JSX and get code-splitting for free:
//
//   // counter.tsx  ("use client"; export const resumable = true)
//   const count = useSignal(0);
//   <button onClick={() => count.value++}>+</button>   // ← transformed automatically
//
// You can also write a qrl by hand (any route) when you want explicit control:
//
//   import { qrl } from "@denext/denext/client";
//   const onInc = qrl(() => import("./handlers.ts").then((m) => m.increment), "counter#increment");
//   <button onClick={onInc}>+</button>
//
// The handler's code is fetched only when the button is first activated. The id
// must be stable and app-unique so the server-serialized reference and the client
// loader agree across the boundary. A handler's captured component-local values are
// passed as the third argument and read inside the segment via `capturedScope()`.

/**
 * Attribute stamped on a host element carrying its qrl handlers as
 * `"eventType:qrlId eventType:qrlId"`, so a delegated listener can dispatch them
 * without ever running the owning component (resumability, stage 4).
 */
export const DNX_H_ATTR = "data-dnx-h";

/** A handler invoked with a single event argument. */
type HandlerFn<E> = (event: E) => unknown;

/** A reference to a lazily-loaded handler: callable, tagged with its stable id. */
export interface Qrl<E = Event> {
  (event: E): Promise<void>;
  /** Stable id identifying this handler across the server/client boundary. */
  readonly denextQrlId: string;
  /**
   * The handler's captured lexical scope, if any — the live values the extracted
   * segment closes over (component-local signals/stores and serializable values),
   * read inside the segment via {@link capturedScope}. Absent for a closure-free
   * handler. The build transform supplies this at render/hydration time, so the
   * captures are the owning component's live objects; a click on an
   * as-yet-unhydrated island hydrates it (its handlers auto-pick the `interaction`
   * strategy) and then runs the handler with those live captures.
   */
  readonly denextCapture?: readonly unknown[];
}

// The captured lexical scope in effect for the handler currently running. Set
// synchronously by the qrl callable immediately before it invokes the loaded fn,
// and read synchronously at the top of that fn via `capturedScope()` (the Qwik
// contract: capture is consumed at handler entry, not across an await). Restored
// after the call so nested/re-entrant handlers don't leak scope to one another.
let currentScope: readonly unknown[] | undefined;

/**
 * Read the captured lexical scope inside an extracted qrl handler segment. The
 * build transform emits `const [a, b] = capturedScope()` at the top of a
 * segment whose handler closed over component-local `a`/`b`; the values are the
 * capture array passed to {@link qrl} (restored from the resume payload on the
 * client). Must be called synchronously at handler entry.
 *
 * @returns The captured values, in the order the transform emitted them.
 * @throws If called outside a running qrl handler (no scope is in effect).
 */
export function capturedScope<T extends readonly unknown[] = readonly unknown[]>(): T {
  if (currentScope === undefined) {
    throw new Error(
      "capturedScope() called outside a qrl handler — it is only valid at the " +
        "top of a build-extracted handler segment.",
    );
  }
  return currentScope as T;
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
 * @param id A stable, app-unique identifier for this handler. **Must be static**
 *   (a module constant), not derived from render/request data: ids are process-
 *   global registry keys, and an id must contain no whitespace or `:` — those are
 *   the delimiters of the `data-dnx-h` attribute the client parses, so an id with
 *   one would corrupt dispatch.
 * @param capture The handler's captured lexical scope — the component-local values
 *   the extracted segment reads via {@link capturedScope}. Omit for a closure-free
 *   handler. Only serializable/resumable captures (signals, stores, serializable
 *   values) are valid; the build transform never emits a capture it can't serialize.
 * @returns A callable {@link Qrl} usable directly as an event-handler prop.
 */
export function qrl<E = Event>(
  loader: () => Promise<(event: E) => unknown>,
  id: string,
  capture?: readonly unknown[],
): Qrl<E> {
  if (/[\s:]/.test(id)) {
    throw new Error(
      `qrl: id ${JSON.stringify(id)} must not contain whitespace or ":" ` +
        "(they delimit the data-dnx-h dispatch attribute).",
    );
  }
  registry().set(id, loader as () => Promise<HandlerFn<unknown>>);
  const ref = async (event: E): Promise<void> => {
    const fn = await loader();
    const prev = currentScope;
    currentScope = capture;
    try {
      await fn(event);
    } finally {
      currentScope = prev;
    }
  };
  return Object.assign(ref, {
    denextQrlId: id,
    ...(capture ? { denextCapture: capture } : {}),
  }) as Qrl<E>;
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
 * @param capture The captured lexical scope restored from the resume payload
 *   (the deserialized `s:[…]` of the `{$:"e"}` reference), made available to the
 *   handler segment via {@link capturedScope}. Omit for a closure-free handler.
 */
export function qrlStub<E = Event>(id: string, capture?: readonly unknown[]): Qrl<E> {
  const ref = async (event: E): Promise<void> => {
    const loader = registry().get(id);
    if (!loader) {
      console.warn("denext: no qrl registered for", id);
      return;
    }
    const fn = await loader();
    const prev = currentScope;
    currentScope = capture;
    try {
      await fn(event as unknown);
    } finally {
      currentScope = prev;
    }
  };
  return Object.assign(ref, {
    denextQrlId: id,
    ...(capture ? { denextCapture: capture } : {}),
  }) as Qrl<E>;
}

/** The registered loader for `id`, if any (used by lazy-attach). */
export function getQrlLoader(id: string): (() => Promise<HandlerFn<unknown>>) | undefined {
  return registry().get(id);
}
