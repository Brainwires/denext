// A Flight page's Server Action call: the dispatch with the wire encoder (the `denext/action-call`
// entry). The generated Flight entry is the only module that imports it, dynamically
// (`setActionCallLoader`), so it is an on-demand chunk in a Flight app and absent from every other
// app: the encoder's file is reachable from startup graphs that import `denext` (the typed API
// client uses it), and a chunk that uses it from there would hoist it into them.

import { dispatchAction } from "./action-dispatch.ts";
import { prepareWire } from "../runtime/wire-encode.ts";

/**
 * Call the Server Action `id` with `args` from the browser.
 *
 * @param id The action id.
 * @param args The call's arguments.
 * @param refresh Re-renders the current route after an action that revalidated or refreshed.
 * @param decode The wire decoder, for a codec-encoded result.
 * @returns The action's result.
 */
export function callAction(
  id: string,
  args: unknown[],
  refresh: (() => void) | null,
  decode: (value: unknown) => unknown,
): Promise<unknown> {
  return dispatchAction(id, args, refresh, decode, prepareWire);
}
