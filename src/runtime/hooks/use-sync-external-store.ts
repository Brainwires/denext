// The public `useSyncExternalStore`: the installed dispatcher's own (the server's), else the client fiber
// dispatcher's, which lives in src/client/fiber/hooks/use-sync-external-store.ts so a bundle carries it only when
// the app calls `useSyncExternalStore` (see src/client/fiber/hooks-dispatcher.ts).

import type { ClientHookHost } from "../../client/fiber/hooks-dispatcher.ts";
import { activeDispatcher } from "../hooks.ts";
import { clientUseSyncExternalStore } from "../../client/fiber/hooks/use-sync-external-store.ts";

/**
 * Subscribe to an external (non-React) store and re-render when it changes.
 * `subscribe` registers a change listener and returns an unsubscribe function;
 * `getSnapshot` reads the current value; `getServerSnapshot` (optional) provides
 * the value used during server rendering.
 *
 * @param subscribe Registers a change listener; returns its unsubscribe.
 * @param getSnapshot Reads the store's current value.
 * @param getServerSnapshot The value for the server render (and hydration).
 * @returns The store's snapshot.
 */
export function useSyncExternalStore<T>(
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot?: () => T,
): T {
  const d = activeDispatcher();
  return d.useSyncExternalStore
    ? d.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
    : clientUseSyncExternalStore(d as ClientHookHost, subscribe, getSnapshot, getServerSnapshot);
}
