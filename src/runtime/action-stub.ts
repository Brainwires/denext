// The generic browser stub for a Server Action reference, and `serverAction()`, whose browser
// branch returns one.
//
// Used by the stubs the build generates for a `"use server"` module a client module imports (they
// import `clientActionStub` from the internal `denext/action-stub` entry), by `serverAction()` and
// `defineSubscription()` in a browser bundle. The Flight client builds its own references
// (src/client/flight-client.ts) and never imports this file.
//
// Why a file of its own: the bundler places code by FILE. This stub needs the wire encoder, and a
// page's startup chunks must not statically reach the encoder's file when a lazily loaded chunk
// (the Flight client's action call) uses it — so the encoder is imported only here and in the
// on-demand chunks, never by server-action.ts, which every client graph reaches. The dispatch
// itself is the on-demand `action-dispatch-*` chunk, which imports nothing: what it needs, this
// stub hands it with each call (an app whose page never makes a call ships the encoder only).

import {
  actionReference,
  actionRefreshHandler,
  registerServerReference,
  type ServerActionRef,
} from "./server-action.ts";
import { decodeWire } from "./wire-codec.ts";
import { prepareWire } from "./wire-encode.ts";

/**
 * Define a server action. Give it a **stable, explicit id** (unique per app) so
 * the client stub and the server handler agree across the boundary.
 *
 * On the server the returned function runs `handler` directly and registers it
 * for RPC dispatch. In the browser it returns a stub that POSTs the arguments to
 * the action endpoint and resolves with the JSON result.
 *
 * The handler runs with the request's async context, so it may read
 * `cookies()`/`headers()`, call `revalidatePath`/`revalidateTag`, or `redirect()`.
 * It **must** authorize and validate its own input — registration alone exposes
 * it to any same-origin caller.
 *
 * @param id A stable, app-unique identifier for this action.
 * @param handler The server-side implementation.
 * @returns A {@link ServerActionRef} usable as a `<form action>` or called directly.
 */
export function serverAction<A extends unknown[], R>(
  id: string,
  handler: (...args: A) => R | Promise<R>,
): ServerActionRef<A, R> {
  if (typeof document !== "undefined") return clientActionStub<A, R>(id);
  return registerServerReference(id, handler);
}

/**
 * Build a browser dispatch stub for a server-reference id: a callable that POSTs its arguments to
 * the action endpoint, tagged with `denextActionId`. The first stub a page creates starts loading
 * the dispatch chunk, so the first call does not wait on it.
 *
 * @param id The server-reference / action id.
 * @returns The stub.
 */
export function clientActionStub<A extends unknown[], R>(id: string): ServerActionRef<A, R> {
  void loadActionDispatch(); // the page has an action: fetch its dispatch while the user reads
  return actionReference<A, R>(id, callAction);
}

/** One call through the on-demand dispatch. */
function callAction(id: string, args: unknown[]): Promise<unknown> {
  return loadActionDispatch().then((m) =>
    m.dispatchAction(id, args, actionRefreshHandler(), decodeWire, prepareWire)
  );
}

/** The client dispatch chunk, imported once. */
let actionDispatch: Promise<typeof import("../client/action-dispatch.ts")> | undefined;

/** {@linkcode actionDispatch}, imported on first use. */
function loadActionDispatch(): Promise<typeof import("../client/action-dispatch.ts")> {
  return actionDispatch ??= import("../client/action-dispatch.ts");
}
