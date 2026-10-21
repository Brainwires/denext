// useId on the client fiber dispatcher, in its own module so an app that never calls it ships
// none of it (see ../hooks-dispatcher.ts). Linked by the public hook, src/runtime/hooks/use-id.ts.
// It imports nothing of the reconciler: what it needs is the client dispatcher's
// {@linkcode ClientHookHost} members, which the public hook hands it.

import { nextId } from "../../../jsx/tree-id.ts";
import { HK_ID } from "../hook-kinds.ts";
import type { ClientHookHost } from "../hooks-dispatcher.ts";

/**
 * `useId` for the component the client reconciler is rendering.
 *
 * @param host The client dispatcher.
 * @returns The component's id, stable across renders and equal to the server's.
 */
export function clientUseId(host: ClientHookHost): string {
  const cell = host.cell(HK_ID);
  if (!cell.inited) {
    // Derived from the fiber's tree position (set at its first render), so it
    // matches the server render / hole / island regardless of streaming order.
    cell.value = nextId(host.fiber().idScope!);
    cell.inited = true;
  }
  return cell.value as string;
}
