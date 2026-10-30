// The Live hub's Lustre half (`defineLustreView`): one Lustre server-component runtime per mounted
// view per connection, its messages carried over the Live socket. Built as a factory over the
// hub's primitives (`createLustreViewHub(deps)`), like the live-view half (live-views.ts), so it
// never imports `live.ts`.
//
// Every `lustre-mount`, in order: frame shape; the per-connection view cap; the props size cap; a
// registered view and a token the server signed over exactly these props (under the Lustre
// namespace, so a live-view token never mounts one; either failing is `gone`); the props decode;
// the view's `authorize` in the viewer's session (a throw is a deny); a post-await connected + cap
// re-check. Then a runtime parked here under the `resume` id (same view, same signed props, same
// viewer — `viewerIdentity`) is
// reattached, or a new one starts (`init` runs). Lustre's model is not serialisable, so nothing is
// written to the shared view store: another instance runs `init` again.
//
// The runtime's messages (Lustre's `ClientMessage` JSON) go to the owning connection only, as
// `lustre` frames under that connection's view id. The first is `mount`, the whole view; its size
// counts against `maxViewBytesPerConnection`. While the socket is back-pressured nothing is queued:
// the view is marked behind, its patches are dropped, and once the socket drains the runtime's
// callback is registered again, which sends a fresh `mount` (the client catches up in one frame).
//
// Every `lustre-event`: the view must be this connection's own (a view id is looked up in the
// sending connection's map only, so one connection's events never reach another's view); a bounded
// per-view inbox (in order; a flood past it is refused with `limit`); the built-in shape check
// (Lustre's `EventFired` only, a bounded path and name, a small plain-JSON event); the view's
// `events` schema; `authorize` again once its TTL passed; then Lustre's own decoder. `authorize`
// also re-runs on a timer every `channelAuthTtlSeconds` while the view is attached, so a viewer
// who lost access stops receiving pushes even without sending anything.
//
// A dropped connection parks its views for `viewResumeSeconds` (at most `maxParkedViews` across
// the hub, oldest stopped); a stopped view's runtime is shut down and every timer cleared.

import { fieldErrorsFrom, isStandardSchema } from "../runtime/define-action.ts";
import { toClientError } from "../runtime/error-boundary.ts";
import type { LiveServerMessage } from "../runtime/live-protocol.ts";
import {
  getLustreView,
  type LustreEventPayload,
  lustreTokenName,
  type LustreViewDef,
  lustreViewFlags,
} from "../lustre/view.ts";
import type { LustreServerRuntime } from "../lustre/server-kit.ts";
import { inRootContext } from "./root-context.ts";
import {
  type AdmitPolicy,
  authorizeView,
  endView,
  enqueueEvent,
  type MountShape,
  mountView,
  str,
  takeParked,
  viewerIdentity,
  type ViewHubBaseDeps,
  type ViewHubFrames,
} from "./view-hub-common.ts";

/** The hub connection surface this module needs. */
export interface LustreConn {
  /** The peer id. */
  peerId: string;
  /** This connection's mounted Lustre views, by client view id. */
  lustreViews: Map<string, LustreViewInstance>;
  /** View ids whose frames a back-pressured socket held back (re-mounted on drain). */
  recoverLustre?: Set<string>;
}

/** What the hub lends this module. */
export type LustreHubDeps<C extends LustreConn> = ViewHubBaseDeps<C>;

/** One server-held Lustre view, as a connection's map holds it. */
export interface LustreViewInstance {
  /** The resumable instance id (sent to the client on `mount`). */
  readonly iid: string;
  /** The view's definition. */
  readonly def: LustreViewDef;
}

interface Instance<C> extends LustreViewInstance {
  vid: string;
  props: unknown;
  /** `view + "\0" + token`: a resume must present the same signed props. */
  signed: string;
  /** The viewer it was mounted for (`viewerIdentity`): only the same viewer resumes it. */
  identity: string;
  owner: C;
  attached: boolean;
  stopped: boolean;
  runtime: LustreServerRuntime;
  /** Stops the runtime's messages to the current connection. */
  disconnect: (() => void) | null;
  /** Frames were dropped under back-pressure: patches are skipped until a fresh mount. */
  behind: boolean;
  /** Size of the last `mount` frame (the whole view), counted per connection. */
  viewBytes: number;
  inbox: number;
  chain: Promise<void>;
  authExpires: number;
  authTimer?: ReturnType<typeof setTimeout>;
  parkTimer?: ReturnType<typeof setTimeout>;
}

/** The hub's Lustre view operations. */
export interface LustreHub<C extends LustreConn> extends ViewHubFrames<C> {
  /** Stop every runtime (teardown). */
  dispose(): void;
  /** Running runtimes, attached and parked (tests, diagnostics). */
  running(): number;
  /** Parked runtimes. */
  parked(): number;
}

/** Events one view may have waiting (validation is async; they are processed in order). */
export const MAX_LUSTRE_INBOX = 32;

/** Caps on a client event's built-in shape. */
const MAX_EVENT_JSON = 16 * 1024;
const MAX_PATH = 1024;
const MAX_DEPTH = 8;
const MAX_KEYS = 64;
const MAX_ITEMS = 256;
const EVENT_NAME = /^[A-Za-z][\w:.-]{0,63}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Lustre's message kinds (`lustre/runtime/transport`): `EventFired` from the client; `mount`
 * and `reconcile` to it. */
const EVENT_FIRED = 1;
const MOUNT = 0;
const RECONCILE = 1;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Is `v` small, plain JSON (bounded depth, keys, items; no prototype-shaped keys)? */
function plainJson(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === "boolean" || typeof v === "string") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (depth >= MAX_DEPTH || typeof v !== "object") return false;
  return Array.isArray(v) ? plainArray(v, depth) : plainObject(v as object, depth);
}

function plainArray(v: unknown[], depth: number): boolean {
  return v.length <= MAX_ITEMS && v.every((x) => plainJson(x, depth + 1));
}

function plainObject(v: object, depth: number): boolean {
  const entries = Object.entries(v);
  return entries.length <= MAX_KEYS &&
    entries.every(([k, x]) => !UNSAFE_KEYS.has(k) && plainJson(x, depth + 1));
}

/** A small plain-JSON object (an event's data), or `null`. */
function eventData(event: unknown): Record<string, unknown> | null {
  const data = event === undefined ? {} : event;
  if (!isPlainRecord(data) || !plainJson(data)) return null;
  return JSON.stringify(data).length <= MAX_EVENT_JSON ? data : null;
}

/**
 * The built-in shape check of a Lustre view's client event: Lustre's `EventFired` message only
 * (`{ kind: 1, path, name, event }`, the one message denext's client sends), with a bounded path,
 * an event name, and a small plain-JSON event. Returns the cleaned message, or `null`.
 *
 * @param raw The `msg` of a `lustre-event` frame.
 * @returns The message, or `null` when it does not fit.
 */
export function checkLustreEvent(
  raw: unknown,
): { kind: 1; path: string; name: string; event: unknown } | null {
  if (!isPlainRecord(raw) || raw.kind !== EVENT_FIRED) return null;
  const { path, name } = raw;
  if (typeof path !== "string" || path.length > MAX_PATH) return null;
  if (typeof name !== "string" || !EVENT_NAME.test(name)) return null;
  const event = eventData(raw.event);
  return event === null ? null : { kind: EVENT_FIRED, path, name, event };
}

type LustreEvent = NonNullable<ReturnType<typeof checkLustreEvent>>;

/** Lustre's empty `reconcile` (an event that changed nothing): nothing to send. */
function isEmptyReconcile(body: { kind?: unknown; patch?: unknown } | null): boolean {
  return body?.kind === RECONCILE && isPlainRecord(body.patch) &&
    Object.keys(body.patch).length === 0;
}

/**
 * Build the Lustre half of a hub.
 *
 * @param deps The hub primitives.
 * @returns The Lustre view operations.
 */
export function createLustreViewHub<C extends LustreConn>(deps: LustreHubDeps<C>): LustreHub<C> {
  const parkedViews = new Map<string, Instance<C>>();
  const all = new Set<Instance<C>>();

  const own = (conn: C, vid: string): Instance<C> | undefined =>
    conn.lustreViews.get(vid) as Instance<C> | undefined;

  const ttlMs = () => deps.limits().channelAuthTtlSeconds * 1000;

  /** Stop delivering the runtime's messages to the connection (it keeps running). */
  const detach = (inst: Instance<C>): void => {
    const disconnect = inst.disconnect;
    inst.disconnect = null;
    disconnect?.();
  };

  const stop = (inst: Instance<C>): void => {
    if (inst.stopped) return;
    inst.stopped = true;
    clearTimeout(inst.authTimer);
    clearTimeout(inst.parkTimer);
    inst.authTimer = inst.parkTimer = undefined;
    detach(inst);
    inst.def.kit.stop(inst.runtime);
    parkedViews.delete(inst.iid);
    all.delete(inst);
    if (inst.owner.lustreViews.get(inst.vid) === inst) inst.owner.lustreViews.delete(inst.vid);
    inst.owner.recoverLustre?.delete(inst.vid);
  };

  /** A runtime error (Lustre's `update` / `view` threw): logged, the client told. */
  const fail = (inst: Instance<C>, err: unknown): void => {
    console.error(`denext lustre view ${inst.def.id}:`, err);
    if (!inst.attached || inst.stopped || !deps.isConnected(inst.owner)) return;
    const { message, digest } = toClientError(err);
    deps.sendError(inst.owner, "failed", message, {
      subId: inst.vid,
      ...(digest ? { digest } : {}),
    });
  };

  /** Re-run `authorize` (the TTL passed); `false` ended the view. */
  const reauthorize = async (inst: Instance<C>): Promise<boolean> => {
    if (!(await authorizeView(deps, inst.owner, inst.def.authorize, inst.props))) {
      if (!inst.stopped) endView(deps, inst, "denied", "view not permitted", () => stop(inst));
      return false;
    }
    inst.authExpires = Date.now() + ttlMs();
    return true;
  };

  /** While attached, `authorize` again every TTL. */
  const armAuth = (inst: Instance<C>): void => {
    clearTimeout(inst.authTimer);
    inst.authTimer = inRootContext(() =>
      setTimeout(() => {
        inst.authTimer = undefined;
        if (inst.stopped || !inst.attached) return;
        void reauthorize(inst).then((ok) => ok && inst.attached && armAuth(inst));
      }, ttlMs())
    );
  };

  /** Bytes of whole-view frames the connection's other views hold. */
  const viewBytesHeld = (conn: C, except: Instance<C>): number => {
    let total = 0;
    for (const v of conn.lustreViews.values()) {
      if (v !== except) total += (v as Instance<C>).viewBytes;
    }
    return total;
  };

  /** Mark the view behind: its patches are dropped until the drained socket gets a fresh mount. */
  const holdBack = (inst: Instance<C>): void => {
    inst.behind = true;
    (inst.owner.recoverLustre ??= new Set()).add(inst.vid);
    deps.armRecover(inst.owner);
  };

  /** A `mount` within the connection's view budget (over it, the view ends with `limit`). */
  const fitsBudget = (inst: Instance<C>, bytes: number): boolean => {
    if (viewBytesHeld(inst.owner, inst) + bytes <= deps.limits().maxViewBytesPerConnection) {
      inst.viewBytes = bytes;
      inst.behind = false;
      return true;
    }
    endView(deps, inst, "limit", "view state too large", () => stop(inst));
    return false;
  };

  /** Should this runtime message go out now? (Not when stopped, parked, behind or empty.) */
  const sendable = (inst: Instance<C>, body: { kind?: unknown } | null, isMount: boolean) =>
    !inst.stopped && inst.attached && deps.isConnected(inst.owner) &&
    (isMount || !inst.behind) && !isEmptyReconcile(body);

  /** One of the runtime's messages, to the connection the view is attached to. */
  const deliver = (inst: Instance<C>, json: unknown): void => {
    const body = json as { kind?: unknown } | null;
    const isMount = body?.kind === MOUNT;
    if (!sendable(inst, body, isMount)) return;
    if (deps.backPressured(inst.owner)) return holdBack(inst);
    const frame: LiveServerMessage = {
      type: "lustre",
      vid: inst.vid,
      msg: json,
      ...(isMount ? { iid: inst.iid } : {}),
    };
    const text = JSON.stringify(frame);
    if (isMount && !fitsBudget(inst, text.length)) return;
    deps.sendFrame(inst.owner, text, frame);
  };

  /** (Re)connect the runtime to the view's connection: Lustre sends `mount` at once. */
  const connect = (inst: Instance<C>): void => {
    detach(inst);
    inst.behind = false;
    inst.disconnect = inst.def.kit.connect(inst.runtime, (json) => deliver(inst, json));
  };

  const attach = (conn: C, vid: string, inst: Instance<C>): void => {
    conn.lustreViews.set(vid, inst);
    all.add(inst);
    inst.vid = vid;
    inst.owner = conn;
    inst.attached = true;
    inst.authExpires = Date.now() + ttlMs();
    armAuth(inst);
    connect(inst);
  };

  const atCap = (conn: C, vid: string): boolean =>
    !conn.lustreViews.has(vid) && conn.lustreViews.size >= deps.limits().maxViewsPerConnection;

  /** The mount checks (view-hub-common.ts `admitView`), with this half's registry. */
  const policy = (conn: C): AdmitPolicy<LustreViewDef> => ({
    atCap: (vid) => atCap(conn, vid),
    lookup: getLustreView,
    tokenName: lustreTokenName,
    authorize: (def, props) => authorizeView(deps, conn, def.authorize, props),
  });

  /** A new runtime for an admitted view (`init` runs); `null` (answered) when it throws. */
  const start = (
    conn: C,
    vid: string,
    admitted: { def: LustreViewDef; props: unknown },
    signed: string,
    identity: string,
  ): Instance<C> | null => {
    const { def, props } = admitted;
    let self: Instance<C> | null = null;
    let runtime: LustreServerRuntime;
    try {
      runtime = def.kit.start(def.app, lustreViewFlags(def, props), (err) => fail(self!, err));
    } catch (err) {
      console.error(`denext lustre view ${def.id}: init failed`, err);
      deps.sendError(conn, "failed", toClientError(err).message, { subId: vid });
      return null;
    }
    self = {
      iid: crypto.randomUUID(),
      vid,
      def,
      props,
      signed,
      identity,
      owner: conn,
      attached: false,
      stopped: false,
      runtime,
      disconnect: null,
      behind: false,
      viewBytes: 0,
      inbox: 0,
      chain: Promise.resolve(),
      authExpires: 0,
    };
    return self;
  };

  /**
   * Put an admitted view on the connection: the runtime parked here for the same viewer, else a
   * new one.
   */
  const place = async (
    conn: C,
    shape: MountShape,
    admitted: { def: LustreViewDef; props: unknown },
  ): Promise<void> => {
    const signed = `${shape.view}\0${shape.token}`;
    const identity = await viewerIdentity(deps, conn);
    if (!deps.isConnected(conn)) return;
    if (atCap(conn, shape.vid)) {
      return deps.sendError(conn, "limit", "too many views", { subId: shape.vid });
    }
    const replaced = own(conn, shape.vid);
    if (replaced) stop(replaced);
    const inst = takeParked(parkedViews, shape.resume, shape.view, signed, identity) ??
      start(conn, shape.vid, admitted, signed, identity);
    if (inst) attach(conn, shape.vid, inst);
  };

  /** The event after the view's `events` schema; `null` (answered) when it is refused. */
  const validEvent = async (
    inst: Instance<C>,
    message: LustreEvent,
  ): Promise<LustreEvent | null> => {
    const schema = inst.def.events;
    if (!schema) return message;
    if (!isStandardSchema(schema)) {
      throw new TypeError("defineLustreView: `events` is not a Standard Schema");
    }
    const payload: LustreEventPayload = { name: message.name, event: message.event };
    const result = await schema["~standard"].validate(payload);
    if (!result.issues) return { ...message, event: result.value.event };
    deps.sendError(inst.owner, "invalid-input", "invalid event payload", {
      subId: inst.vid,
      fieldErrors: fieldErrorsFrom(result.issues),
    });
    return null;
  };

  /** The event, shape-checked and schema-validated; `null` (answered) when refused. */
  const acceptEvent = (inst: Instance<C>, raw: unknown): Promise<LustreEvent | null> => {
    const message = checkLustreEvent(raw);
    if (message !== null) return validEvent(inst, message);
    deps.sendError(inst.owner, "invalid-input", "malformed event payload", { subId: inst.vid });
    return Promise.resolve(null);
  };

  /** Is the view still live, and its viewer still authorized (re-checked once the TTL passed)? */
  const stillLive = async (inst: Instance<C>): Promise<boolean> => {
    if (inst.stopped || !inst.attached) return false;
    if (Date.now() >= inst.authExpires && !(await reauthorize(inst))) return false;
    return !inst.stopped && inst.attached;
  };

  const processEvent = async (inst: Instance<C>, raw: unknown): Promise<void> => {
    if (inst.stopped || !inst.attached) return;
    const event = await acceptEvent(inst, raw);
    if (event === null || !(await stillLive(inst))) return;
    if (!inst.def.kit.receive(inst.runtime, event)) {
      deps.sendError(inst.owner, "bad-message", "undecodable event", { subId: inst.vid });
    }
  };

  const park = (inst: Instance<C>): void => {
    const { viewResumeSeconds, maxParkedViews } = deps.limits();
    inst.attached = false;
    clearTimeout(inst.authTimer);
    inst.authTimer = undefined;
    detach(inst);
    parkedViews.set(inst.iid, inst);
    // The park timer serves the runtime, not the closing socket's handler context.
    inst.parkTimer = inRootContext(() => setTimeout(() => stop(inst), viewResumeSeconds * 1000));
    while (parkedViews.size > maxParkedViews) {
      stop(parkedViews.values().next().value as Instance<C>);
    }
  };

  return {
    mount: (conn, msg) =>
      mountView(deps, conn, msg, policy(conn), (shape, admitted) => place(conn, shape, admitted)),

    event(conn, msg) {
      const vid = str(msg.vid, 64);
      const inst = vid === null ? undefined : own(conn, vid);
      if (!inst) return;
      enqueueEvent(
        deps,
        conn,
        inst.vid,
        inst,
        MAX_LUSTRE_INBOX,
        () => processEvent(inst, msg.msg),
        (err) => fail(inst, err),
      );
    },

    unmount(conn, vid) {
      const inst = typeof vid === "string" ? own(conn, vid) : undefined;
      if (inst) stop(inst);
    },

    resync(conn, vid) {
      const inst = typeof vid === "string" ? own(conn, vid) : undefined;
      if (inst && !inst.stopped) connect(inst);
    },

    drop(conn) {
      for (const v of [...conn.lustreViews.values()]) {
        const inst = v as Instance<C>;
        conn.lustreViews.delete(inst.vid);
        if (!inst.stopped) park(inst);
      }
      conn.recoverLustre = undefined;
    },

    discard(conn) {
      for (const v of [...conn.lustreViews.values()]) stop(v as Instance<C>);
      conn.lustreViews.clear();
      conn.recoverLustre = undefined;
    },

    replayPending(conn) {
      const ids = conn.recoverLustre;
      conn.recoverLustre = undefined;
      for (const vid of ids ?? []) {
        const inst = own(conn, vid);
        if (inst && !inst.stopped && inst.behind) connect(inst);
      }
    },

    dispose() {
      for (const inst of [...all]) stop(inst);
      parkedViews.clear();
    },

    running: () => all.size,
    parked: () => parkedViews.size,
  };
}
