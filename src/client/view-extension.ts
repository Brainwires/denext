// What the browser halves of the two server-held view kinds share: `defineLiveView`
// (live-view-client.ts) and `defineLustreView` (lustre/view-client.ts). Each keeps its mounted
// views in a map, re-mounts them on every (re)connect, holds events while the socket is down, and
// treats a server refusal the same way; only the frames in between differ.

import type { LiveClientMessage, LiveError, LiveServerMessage } from "../runtime/live-protocol.ts";
import {
  type LiveExtension,
  refreshLiveRoute,
  releaseLiveSocket,
  sendLiveFrame,
} from "./live-client.ts";

/** What a mounted view keeps that this module reads. */
export interface ViewSlot {
  /** The view id (for messages). */
  view: string;
  /** The server answered the current mount (events go out). */
  live: boolean;
  /** Refused for good: not re-mounted on reconnect. */
  dead?: boolean;
  /** Already asked the route to re-render once for a fresh token. */
  refreshed?: boolean;
}

/** Error codes after which re-mounting the same view can only fail again. */
const TERMINAL = new Set(["denied", "no-policy", "limit", "bad-message"]);

/**
 * Apply a server error to a view: `gone` (the server can't mount it from what the page holds — a
 * restart, another instance, a module not loaded yet) re-renders the route once for fresh props
 * and a token; a terminal refusal ends it; anything else is logged.
 *
 * @param v The view.
 * @param error The error frame.
 * @param label How the log names the view kind (`live view`, `lustre view`).
 */
export function applyViewError(v: ViewSlot, error: LiveError, label: string): void {
  if (error.code === "gone") {
    v.dead = true;
    if (!v.refreshed) {
      v.refreshed = true;
      refreshLiveRoute();
    }
    return;
  }
  if (TERMINAL.has(error.code)) v.dead = true;
  console.warn(`denext ${label} ${v.view}: ${error.reason ?? error.code}`);
}

/**
 * The Live transport extension for a map of views: `handle` gets each server frame first, every
 * (re)connect re-mounts the views not refused for good, and a closed socket holds their events
 * until the re-mount answers.
 *
 * @param views The mounted views, by view id.
 * @param mountFrame The mount frame of one view.
 * @param handle The view kind's own frames.
 * @returns The extension, for `registerLiveExtension`.
 */
export function viewExtension<V extends ViewSlot>(
  views: Map<string, V>,
  mountFrame: (vid: string, v: V) => LiveClientMessage,
  handle: (msg: LiveServerMessage) => boolean,
): LiveExtension {
  return {
    handle,
    resend() {
      for (const [vid, v] of views) {
        if (v.dead) continue;
        v.live = false;
        sendLiveFrame(mountFrame(vid, v));
      }
    },
    active: () => views.size > 0,
    closed() {
      for (const v of views.values()) v.live = false;
    },
  };
}

/**
 * Stop a view: drop it, tell the server, and let the socket close when nothing else needs it.
 *
 * @param views The mounted views.
 * @param vid The view's id.
 * @param frame The unmount frame.
 */
export function unmountView(
  views: Map<string, unknown>,
  vid: string,
  frame: LiveClientMessage,
): void {
  if (!views.delete(vid)) return;
  sendLiveFrame(frame);
  releaseLiveSocket();
}
