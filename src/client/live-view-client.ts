// The browser half of `defineLiveView`: mounts views over the Live socket, applies the server's
// renders and patches, and sends `send(…)`-bound events. A Live transport extension
// (`registerLiveExtension`), so this module ships only with the `denext#LiveView` island.
//
// Per view it keeps the server's Flight tree at revision `rev`. A `view-render` replaces it; a
// `view-patch` applies when its `base` is the held revision (otherwise the client asks for a
// `view-resync`). Each new tree is parsed through the app's registry and handed to the island in
// order (a promise chain: a parse may first load island chunks). Events fired before the first
// render (the server is still running `init`) wait in a short queue, as do events while the
// socket is reconnecting; a reconnect re-mounts with the instance id the server gave, so a view
// parked on the server picks up where it was.

import type { FlightNode } from "../jsx/render-to-flight.ts";
import type { VNodeChild } from "../jsx/types.ts";
import type { EventPayload } from "../runtime/mvu.ts";
import { applyFlightOps, FlightPatchError } from "../runtime/flight-patch.ts";
import type { LiveServerMessage } from "../runtime/live-protocol.ts";
import {
  type LiveErrorInfo,
  openLiveSocket,
  parseLiveFlight,
  registerLiveExtension,
  sendLiveFrame,
} from "./live-client.ts";
import { applyViewError, unmountView, viewExtension } from "./view-extension.ts";

/** What the island mounts a view with (all of it from the server's render of the page). */
export interface LiveViewSpec {
  /** The view id. */
  view: string;
  /** The props as signed JSON text. */
  props: string;
  /** `1` when the props carry wire-codec tags. */
  enc?: 1;
  /** The server's signature over the props. */
  token: string;
}

/** Callbacks into the island. */
export interface LiveViewCallbacks {
  /** A new tree (parsed VNodes, with handler references still in the `on*` props). */
  onTree(tree: VNodeChild): void;
  /** The server refused or failed the view. */
  onError?(info: LiveErrorInfo): void;
}

/** The island's handle on a mounted view. */
export interface LiveViewHandle {
  /** Send an event for handler `h` of the tree on screen. */
  event(h: number, payload: EventPayload): void;
  /** Stop the view. */
  unmount(): void;
}

interface ViewState extends LiveViewSpec {
  cb: LiveViewCallbacks;
  /** The instance id to resume with. */
  iid?: string;
  /** The revision of `flight` (0: none yet). */
  rev: number;
  flight: FlightNode[] | null;
  /** The server answered the current mount (events go straight out). */
  live: boolean;
  queue: Array<{ h: number; payload: EventPayload }>;
  chain: Promise<void>;
  /** Refused for good: not re-mounted on reconnect. */
  dead?: boolean;
  /** Already asked the route to re-render once for a fresh token. */
  refreshed?: boolean;
}

/** Events held while a view is not mounted yet (more are dropped). */
const MAX_QUEUED = 16;

const views = new Map<string, ViewState>();
let counter = 0;
let detach: (() => void) | null = null;

function mountFrame(vid: string, v: ViewState) {
  return {
    type: "view-mount" as const,
    vid,
    view: v.view,
    props: v.props,
    token: v.token,
    ...(v.enc ? { enc: v.enc } : {}),
    ...(v.iid ? { resume: v.iid } : {}),
  };
}

/** Parse `flight` and hand it to the view, in order after anything already pending. */
function show(v: ViewState, flight: FlightNode[]): void {
  v.chain = v.chain.then(async () => {
    const tree = parseLiveFlight(flight);
    if (tree === null) return;
    v.cb.onTree(await tree);
  }).catch((err) => console.warn("denext: live view render failed:", (err as Error)?.message));
}

function flush(vid: string, v: ViewState): void {
  const queued = v.queue.splice(0);
  for (const e of queued) send(vid, v, e.h, e.payload);
}

function send(vid: string, v: ViewState, h: number, payload: EventPayload): void {
  sendLiveFrame({ type: "view-event", vid, rev: v.rev, h, payload });
}

function onRender(msg: Extract<LiveServerMessage, { type: "view-render" }>): void {
  const v = views.get(msg.vid);
  if (!v || !Array.isArray(msg.flight)) return;
  v.rev = msg.rev;
  v.iid = msg.iid;
  v.flight = msg.flight;
  v.live = true;
  show(v, msg.flight);
  flush(msg.vid, v);
}

function onPatch(msg: Extract<LiveServerMessage, { type: "view-patch" }>): void {
  const v = views.get(msg.vid);
  if (!v) return;
  if (!v.flight || msg.base !== v.rev || !Array.isArray(msg.ops)) {
    return sendLiveFrame({ type: "view-resync", vid: msg.vid });
  }
  let next: FlightNode[];
  try {
    next = applyFlightOps(v.flight, msg.ops);
  } catch (err) {
    if (!(err instanceof FlightPatchError)) throw err;
    return sendLiveFrame({ type: "view-resync", vid: msg.vid });
  }
  v.flight = next;
  v.rev = msg.rev;
  show(v, next);
}

function onError(msg: Extract<LiveServerMessage, { type: "error" }>): boolean {
  const v = msg.subId === undefined ? undefined : views.get(msg.subId);
  if (!v) return false;
  applyViewError(v, msg, "live view");
  v.cb.onError?.(msg);
  return true;
}

function ensureExtension(): void {
  if (detach) return;
  detach = registerLiveExtension(viewExtension(views, mountFrame, (msg) => {
    switch (msg.type) {
      case "view-render":
        onRender(msg);
        return true;
      case "view-patch":
        onPatch(msg);
        return true;
      case "error":
        return onError(msg);
      default:
        return false;
    }
  }));
}

/**
 * Mount a server-held live view over the Live socket.
 *
 * @param spec The view id, its signed props and token.
 * @param cb Where new trees and errors go.
 * @returns The handle the island sends events through.
 */
export function mountLiveView(spec: LiveViewSpec, cb: LiveViewCallbacks): LiveViewHandle {
  ensureExtension();
  const vid = `v${++counter}`;
  const v: ViewState = {
    ...spec,
    cb,
    rev: 0,
    flight: null,
    live: false,
    queue: [],
    chain: Promise.resolve(),
  };
  views.set(vid, v);
  openLiveSocket();
  sendLiveFrame(mountFrame(vid, v));
  return {
    event(h, payload) {
      if (!views.has(vid) || v.dead) return;
      if (!v.live) {
        if (v.queue.length < MAX_QUEUED) v.queue.push({ h, payload });
        return;
      }
      send(vid, v, h, payload);
    },
    unmount: () => unmountView(views, vid, { type: "view-unmount", vid }),
  };
}
