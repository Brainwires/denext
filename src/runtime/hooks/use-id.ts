// The public `useId`: the installed dispatcher's own (the server's), else the client fiber
// dispatcher's, which lives in src/client/fiber/hooks/use-id.ts so a bundle carries it only when
// the app calls `useId` (see src/client/fiber/hooks-dispatcher.ts).

import type { ClientHookHost } from "../../client/fiber/hooks-dispatcher.ts";
import { activeDispatcher } from "../hooks.ts";
import { clientUseId } from "../../client/fiber/hooks/use-id.ts";

/**
 * Return a unique, stable id string. The value is deterministic across the
 * server render and client hydration (ids are assigned in render order), so it
 * is safe to use for `id`/`htmlFor`/`aria-*` attributes without a mismatch.
 *
 * @returns The component's id.
 */
export function useId(): string {
  const d = activeDispatcher();
  return d.useId ? d.useId() : clientUseId(d as ClientHookHost);
}
