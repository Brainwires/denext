/**
 * Internal to `denext/mobile`: the URL the iOS share extension opens the app with
 * (`<scheme>://denext-share`), which deep-link routing leaves alone, and the one shared
 * `shareReceived` listener. Not re-exported from `denext/mobile`.
 *
 * @module
 */

import type { Fanout } from "./link-routing.ts";

/** The host of the share hand-off URL. */
const HANDOFF_HOST = "denext-share";

/**
 * Whether `url` is the share extension's hand-off (`<custom scheme>://denext-share`), which
 * `onShareReceived` answers: `onDeepLink` does not route it.
 */
export function isShareHandoff(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  return scheme !== "http" && scheme !== "https" && parsed.hostname.toLowerCase() === HANDOFF_HOST;
}

/** The one native listener every `onShareReceived` subscriber shares. */
export const shareListener: { fanout?: Fanout<unknown> } = {};

/** Forget the shared listener (tests only). */
export function resetShareReceiveForTesting(): void {
  shareListener.fanout = undefined;
}
