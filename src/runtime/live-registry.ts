/**
 * The seam between the `<Live>` component and the client WebSocket runtime.
 *
 * `<Live>` is a client island that must stay import-light and SSR-safe (it is also
 * invoked on the server for first-paint HTML). Rather than statically importing the
 * WebSocket client — which would pull the client transport into the server graph —
 * it registers through this dependency-free seam. The client runtime installs a
 * {@link LiveRegistrar} at boot; on the server (or before boot) registration is an
 * inert no-op, so `<Live>` simply renders its children.
 *
 * @module
 */

import type { VNodeChild } from "../jsx/types.ts";

/**
 * Register a mounted `<Live>` boundary with the transport. Returns an unsubscribe
 * to call on unmount. `onPatch` receives the boundary's freshly-parsed children.
 */
export type LiveRegistrar = (
  id: string,
  tags: string[],
  onPatch: (children: VNodeChild) => void,
) => () => void;

let registrar: LiveRegistrar | null = null;

/**
 * Install (or clear, with `null`) the transport that live boundaries register with.
 * Called once by the client runtime at boot.
 */
export function setLiveRegistrar(next: LiveRegistrar | null): void {
  registrar = next;
}

/**
 * Register a boundary with the active transport, or no-op when none is installed
 * (server render, or an app whose client bundle has no live runtime). Returns an
 * unsubscribe function.
 */
export function registerLiveBoundary(
  id: string,
  tags: string[],
  onPatch: (children: VNodeChild) => void,
): () => void {
  return registrar ? registrar(id, tags, onPatch) : () => {};
}
