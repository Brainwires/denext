// The browser half of `defineLustreView`: a Lustre server component's client over the Live socket,
// in place of Lustre's own `<lustre-server-component>` script (an inline module with a hard-coded
// WebSocket / SSE / polling transport). It is a Live transport extension (`registerLiveExtension`),
// so it ships only in the chunk of the island that uses it.
//
// Lustre's own reconciler does the DOM work: on the server's `mount` message (kind 0, the whole
// view) the view's root is emptied and a `Reconciler` mounts the view into it; each `reconcile`
// (kind 1) is a patch for it; `emit` (kind 2) becomes a DOM event on the root. Lustre's contexts
// (kinds 3–5) are not carried. Events the reconciler bound turn into Lustre's `EventFired` message
// with the event's data picked as Lustre's client does (`target.value` / `checked` for input and
// change, `key` for key events, the form's fields for submit, plus the handler's `include` paths),
// sent as a `lustre-event` frame. A patch that fails to apply asks the server for the whole view
// again (`lustre-resync`). A reconnect re-mounts with the instance id the server gave, so a view
// still parked on that server instance carries on where it was.

import type { LiveServerMessage } from "../runtime/live-protocol.ts";
import { openLiveSocket, registerLiveExtension, sendLiveFrame } from "../client/live-client.ts";
import { applyViewError, unmountView, viewExtension } from "../client/view-extension.ts";

/** What the island mounts a view with (all of it from the server's render of the page). */
export interface LustreViewSpec {
  /** The view id. */
  view: string;
  /** The props as signed JSON text. */
  props: string;
  /** `1` when the props carry wire-codec tags. */
  enc?: 1;
  /** The server's signature over the props. */
  token: string;
}

/** Lustre's client reconciler (`lustre/vdom/reconciler.ffi.mjs`), as far as this module uses it. */
export interface LustreReconciler {
  /** Render a whole view into the root. */
  mount(vdom: unknown): void;
  /** Apply a patch to what is mounted. */
  push(patch: unknown): void;
}

/** The `Reconciler` class: `new Reconciler(root, decodeEvent, dispatch)`. */
export type LustreReconcilerClass = new (
  root: Element,
  decodeEvent: (event: Event, path: string, name: string, include?: string[]) => unknown,
  dispatch: (event: Event, data: unknown) => void,
) => LustreReconciler;

/** The island's handle on a mounted view. */
export interface LustreViewHandle {
  /** Stop the view. */
  unmount(): void;
}

interface ViewState extends LustreViewSpec {
  root: Element;
  Reconciler: LustreReconcilerClass;
  reconciler: LustreReconciler | null;
  /** The instance id to resume with. */
  iid?: string;
  /** The server answered the current mount (events go out). */
  live: boolean;
  /** Refused for good: not re-mounted on reconnect. */
  dead?: boolean;
  /** Already asked the route to re-render once for a fresh token. */
  refreshed?: boolean;
}

/** Lustre's message kinds (`lustre/runtime/transport`). */
const MOUNT = 0;
const RECONCILE = 1;
const EMIT = 2;
const EVENT_FIRED = 1;

const views = new Map<string, ViewState>();
let counter = 0;
let detach: (() => void) | null = null;

function mountFrame(vid: string, v: ViewState) {
  return {
    type: "lustre-mount" as const,
    vid,
    view: v.view,
    props: v.props,
    token: v.token,
    ...(v.enc ? { enc: v.enc } : {}),
    ...(v.iid ? { resume: v.iid } : {}),
  };
}

/** The value at `path` (dot-separated) of `from`, copied into `into` at the same path. */
function copyPath(from: unknown, into: Record<string, unknown>, path: string[]): void {
  let input = from as Record<string, unknown> | undefined;
  let output = into;
  for (let i = 0; i < path.length; i++) {
    if (input === null || input === undefined) return;
    const key = path[i];
    if (i === path.length - 1) {
      output[key] = input[key];
      return;
    }
    output = (output[key] ??= {}) as Record<string, unknown>;
    input = input[key] as Record<string, unknown> | undefined;
  }
}

/** The input's value, or `checked` for a checkbox. */
const valuePath = (event: Event) =>
  (event.target as { type?: string } | null)?.type === "checkbox"
    ? "target.checked"
    : "target.value";

/** The event data Lustre's client always includes, by event type. */
const PATHS_BY_TYPE: Record<string, (event: Event) => string> = {
  input: valuePath,
  change: valuePath,
  keydown: () => "key",
  keyup: () => "key",
  keypress: () => "key",
  submit: () => "detail.formData",
};

/**
 * The parts of a DOM event the server sees, as Lustre's own server-component client picks them:
 * `include` paths, plus `detail` for a Lustre event, the input's value (or `checked`) for input
 * and change, `key` for key events and the form's fields for submit.
 *
 * @param event The DOM event.
 * @param include The handler's `include` paths.
 * @returns A plain, JSON-serialisable object.
 */
function serverEventData(event: Event, include: readonly string[] = []): unknown {
  const paths = [...include];
  if ((event as { isLustreEvent?: boolean }).isLustreEvent) paths.push("detail");
  const byType = Object.hasOwn(PATHS_BY_TYPE, event.type) ? PATHS_BY_TYPE[event.type] : null;
  if (byType) paths.push(byType(event));
  const data: Record<string, unknown> = {};
  for (const path of paths) copyPath(event, data, path.split("."));
  return data;
}

/** Mount the server's whole view into the root, with a new reconciler. */
function mountView(vid: string, v: ViewState, vdom: unknown): void {
  v.root.textContent = "";
  const decode = (event: Event, path: string, name: string, include?: string[]) => ({
    kind: EVENT_FIRED,
    path,
    name,
    event: serverEventData(event, include),
  });
  const dispatch = (_event: Event, data: unknown) => {
    if (v.live && !v.dead && views.get(vid) === v) {
      sendLiveFrame({ type: "lustre-event", vid, msg: data });
    }
  };
  v.reconciler = new v.Reconciler(v.root, decode, dispatch);
  v.reconciler.mount(vdom);
  v.root.dispatchEvent(new CustomEvent("lustre:mount"));
}

/** Apply one of the server's Lustre messages to the view. */
function apply(vid: string, v: ViewState, body: Record<string, unknown>, iid: unknown): void {
  if (body.kind === MOUNT) {
    if (typeof iid === "string") v.iid = iid;
    v.live = true;
    return mountView(vid, v, body.vdom);
  }
  if (body.kind === RECONCILE) {
    if (!v.reconciler) return sendLiveFrame({ type: "lustre-resync", vid });
    return v.reconciler.push(body.patch);
  }
  if (body.kind === EMIT && typeof body.name === "string") {
    const init = { detail: body.data, bubbles: true, composed: true };
    v.root.dispatchEvent(new CustomEvent(body.name, init));
  }
}

function onFrame(msg: Extract<LiveServerMessage, { type: "lustre" }>): void {
  const v = views.get(msg.vid);
  const body = msg.msg as Record<string, unknown> | null;
  if (!v || body === null || typeof body !== "object") return;
  try {
    apply(msg.vid, v, body, msg.iid);
  } catch (err) {
    // A patch that does not fit what is on screen: start over from the whole view.
    console.warn(`denext lustre view ${v.view}: resyncing:`, (err as Error)?.message);
    v.reconciler = null;
    sendLiveFrame({ type: "lustre-resync", vid: msg.vid });
  }
}

function onError(msg: Extract<LiveServerMessage, { type: "error" }>): boolean {
  const v = msg.subId === undefined ? undefined : views.get(msg.subId);
  if (!v) return false;
  applyViewError(v, msg, "lustre view");
  return true;
}

function ensureExtension(): void {
  if (detach) return;
  detach = registerLiveExtension(viewExtension(views, mountFrame, (msg) => {
    if (msg.type === "lustre") {
      onFrame(msg);
      return true;
    }
    return msg.type === "error" ? onError(msg) : false;
  }));
}

/**
 * Mount a Lustre server component over the Live socket into `root`.
 *
 * @param spec The view id, its signed props and token.
 * @param root The element the view renders into (its contents are replaced on mount).
 * @param Reconciler Lustre's client reconciler class, from the app's Lustre build.
 * @returns The handle the island stops it with.
 */
export function mountLustreView(
  spec: LustreViewSpec,
  root: Element,
  Reconciler: LustreReconcilerClass,
): LustreViewHandle {
  ensureExtension();
  const vid = `l${++counter}`;
  const v: ViewState = { ...spec, root, Reconciler, reconciler: null, live: false };
  views.set(vid, v);
  openLiveSocket();
  sendLiveFrame(mountFrame(vid, v));
  return { unmount: () => unmountView(views, vid, { type: "lustre-unmount", vid }) };
}
