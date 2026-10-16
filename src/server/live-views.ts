// The Live hub's live-view half (`defineLiveView`): one server-held Model–View–Update instance per
// mounted view per connection. Built as a factory over the hub's primitives
// (`createLiveViewHub(deps)`), like the channel half, so it never imports `live.ts`.
//
// Every check on `view-mount`, in order: frame shape; the per-connection view cap; the props
// size cap; a registered view and a token the server signed over exactly these props (either
// failing is `gone` — the client re-renders the route for fresh ones, and an attacker learns
// nothing); the props decode; the view's `authorize` in the viewer's session (a throw is a
// deny); a post-await connected + cap re-check. Then a parked instance named by `resume` is
// adopted (same view, same signed props), or `init` runs.
//
// Every `view-event`: frame shape; a bounded per-view inbox (events are processed one at a time,
// in order — a flood past it is refused with `limit`, the inbound back-pressure); the handler
// must exist in the render the client names (one of the last `HANDLER_HISTORY` — older is
// stale and dropped); the payload passes the built-in shape check and then the view's `events`
// schema; `authorize` again once `channelAuthTtlSeconds` passed; then the server's own message
// for that handler (or its `send((payload) => msg)` function's result) is dispatched.
//
// After a batch of updates the view re-renders once (single-flight; a burst collapses) inside a
// render slot with the render deadline, as the viewer. The model and the rendered tree count
// against `maxViewBytesPerConnection` (over it, the view ends with `limit`). The client gets the
// Flight diff, or the whole tree when the diff would be larger, after a resync, or after a
// back-pressured socket drained (outbound back-pressure: nothing is queued per patch — the
// client catches up with one full render). A dropped connection parks its views for
// `viewResumeSeconds` (at most `maxParkedViews` across the hub, oldest evicted) so a reconnect
// resumes the model; otherwise the next mount runs `init` again. A parked view's model is also
// written, sealed, to the shared view store (`setLiveViewStore`), and rewritten when it changes
// while parked: a reconnect that reaches another instance (or this one after eviction) takes the
// snapshot back and resumes the model under a new instance id instead of running `init`.

import type { FlightNode } from "../jsx/render-to-flight.ts";
import { renderToFlight } from "../jsx/render-to-flight.ts";
import { fieldErrorsFrom, isStandardSchema } from "../runtime/define-action.ts";
import { toClientError } from "../runtime/error-boundary.ts";
import { diffFlight } from "../runtime/flight-patch.ts";
import type { LiveError, LiveServerMessage } from "../runtime/live-protocol.ts";
import {
  createHandlerTable,
  getLiveView,
  type LiveViewDef,
  verifyLiveViewToken,
} from "../runtime/live-view.ts";
import {
  createMvuEngine,
  type EventPayload,
  type MsgSource,
  type MvuEngine,
  type MvuHost,
  resolveMsg,
} from "../runtime/mvu.ts";
import { decodeWire, prepareWire, WIRE_ENC } from "../runtime/wire-codec.ts";
import { tapChannelAuthorized } from "./channel-subscriber.ts";
import { inRootContext } from "./root-context.ts";
import { type LiveViewStore, openViewSnapshot, sealViewSnapshot } from "./live-view-store.ts";

/** The hub connection surface this module needs. */
export interface ViewConn {
  /** The peer id (channel subscriptions act as it). */
  peerId: string;
  /** The connection's origin (relative effect fetches resolve against it). */
  origin: string;
  /** This connection's mounted views, by client view id. */
  views: Map<string, ViewInstance>;
  /** View ids whose frame was held back by a back-pressured socket (replayed on drain). */
  recoverViews?: Set<string>;
}

/** The caps this module reads (a subset of `live.limits`). */
export interface ViewLimits {
  /** Views one connection may hold. */
  maxViewsPerConnection: number;
  /** Bytes of model + rendered tree one connection's views may hold. */
  maxViewBytesPerConnection: number;
  /** Seconds a dropped connection's views stay resumable. */
  viewResumeSeconds: number;
  /** Parked views across the hub. */
  maxParkedViews: number;
  /** Bytes of a view's props. */
  maxSubscriptionInputBytes: number;
  /** Seconds before `authorize` runs again (on the next event). */
  channelAuthTtlSeconds: number;
}

/** What the hub lends this module. */
export interface ViewHubDeps<C extends ViewConn> {
  /** Current limits. */
  limits(): ViewLimits;
  /** Send a pre-encoded frame (the hub's back-pressure-aware send). */
  sendFrame(conn: C, text: string, msg: LiveServerMessage): void;
  /** Send an error frame. */
  sendError(conn: C, code: LiveError["code"], reason: string, extra?: Partial<LiveError>): void;
  /** Run `fn` inside the connection's own request context (its replayed cookie). */
  withConnContext<T>(conn: C, fn: () => T | Promise<T>): Promise<T>;
  /** The identity handed to `authorize`. */
  connContext(conn: C): { origin: string; url: string; cookie: string; peerId: string };
  /** Is the connection still registered? */
  isConnected(conn: C): boolean;
  /** Run a render: a render slot, the render deadline, the connection's context. */
  render<T>(conn: C, fn: () => Promise<T>): Promise<T>;
  /** Is the socket back-pressured right now? */
  backPressured(conn: C): boolean;
  /** Arm the hub's drain-recovery timer for `conn`. */
  armRecover(conn: C): void;
  /** The shared store parked views are written to (none: parked in this process only). */
  store?(): LiveViewStore | null;
}

/** One server-held view. */
export interface ViewInstance {
  /** The resumable instance id (sent to the client; names a parked instance). */
  readonly iid: string;
  /** The client's id for it on the connection it is attached to. */
  vid: string;
  /** The definition. */
  readonly def: LiveViewDef;
  /** The decoded props `init` ran with. */
  readonly props: unknown;
  /** `view + "\0" + token`: a resume must present the same signed props. */
  readonly signed: string;
}

interface Instance<C> extends ViewInstance {
  owner: C;
  attached: boolean;
  stopped: boolean;
  engine: MvuEngine<unknown, unknown>;
  rev: number;
  flight: FlightNode[] | null;
  flightBytes: number;
  modelBytes: number;
  /** Handler tables by render revision (the last {@link HANDLER_HISTORY}). */
  tables: Map<number, MsgSource<unknown>[]>;
  rendering: boolean;
  dirty: boolean;
  needsFull: boolean;
  inbox: number;
  chain: Promise<void>;
  authExpires: number;
  parkTimer?: ReturnType<typeof setTimeout>;
  /** The store writes for this instance, in order. */
  storeChain?: Promise<void>;
}

/** The hub's live-view operations. */
export interface ViewHub<C extends ViewConn> {
  /** Handle a `view-mount` frame. */
  mount(conn: C, msg: Record<string, unknown>): Promise<void>;
  /** Handle a `view-event` frame. */
  event(conn: C, msg: Record<string, unknown>): void;
  /** Handle a `view-unmount` frame. */
  unmount(conn: C, vid: unknown): void;
  /** Handle a `view-resync` frame. */
  resync(conn: C, vid: unknown): void;
  /** Park every view of a closing connection. */
  drop(conn: C): void;
  /** Stop every view of a connection without parking it (the hub is shutting down). */
  discard(conn: C): void;
  /** Re-send the whole tree of views whose frame was held back (the socket drained). */
  replayPending(conn: C): void;
  /** Stop every instance (teardown). */
  dispose(): void;
  /** Parked instances (tests, diagnostics). */
  parked(): number;
}

/**
 * Renders whose handlers still answer: a burst of clicks sent before the client saw the patch
 * they caused names an older render, and still lands. Older ones are stale (dropped).
 */
export const HANDLER_HISTORY = 16;

/** Events one view may have waiting (validation is async; they are processed in order). */
export const MAX_VIEW_INBOX = 32;

/** Effects one view may have pending at once, and subscriptions it may hold. */
const MAX_VIEW_EFFECTS = 32;

/** The shortest interval subscription on the server. */
const MIN_SERVER_INTERVAL_MS = 100;

/** Caps on an event payload's built-in shape. */
const MAX_VALUE_CHARS = 16 * 1024;
const MAX_KEY_CHARS = 64;
const MAX_FORM_FIELDS = 64;
const MAX_FIELD_NAME = 256;

/**
 * The built-in shape check every event payload passes before the view's own schema: a plain
 * object with only `value` (string), `checked` (boolean), `key` (string) and `form` (string →
 * string), each bounded. Returns the cleaned payload, or `null` when it does not fit.
 *
 * @param raw The payload from the frame.
 * @returns The payload, or `null`.
 */
export function checkEventPayload(raw: unknown): EventPayload | null {
  if (raw === undefined) return {};
  if (!isPlainRecord(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const check = Object.hasOwn(PAYLOAD_FIELDS, k) ? PAYLOAD_FIELDS[k] : undefined;
    const value = check ? check(v) : undefined;
    if (value === undefined) return null;
    out[k] = value;
  }
  return out as EventPayload;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A bounded string, else `undefined`. */
const boundedString = (max: number) => (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

/** Each payload field's check: the cleaned value, or `undefined` when it does not fit. */
const PAYLOAD_FIELDS: Record<string, (v: unknown) => unknown> = {
  value: boundedString(MAX_VALUE_CHARS),
  checked: (v) => typeof v === "boolean" ? v : undefined,
  key: boundedString(MAX_KEY_CHARS),
  form: (v) => checkForm(v) ?? undefined,
};

function checkForm(v: unknown): Record<string, string> | null {
  if (!isPlainRecord(v)) return null;
  const entries = Object.entries(v);
  if (entries.length > MAX_FORM_FIELDS) return null;
  const fieldName = boundedString(MAX_FIELD_NAME);
  const fieldValue = boundedString(MAX_VALUE_CHARS);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    const text = fieldValue(value);
    if (fieldName(name) === undefined || text === undefined) return null;
    out[name] = text;
  }
  return out;
}

/** The JSON size of a model (wire-codec shaped); `Infinity` when it can't be encoded. */
function modelSize(model: unknown): number {
  try {
    return JSON.stringify(prepareWire(model).value ?? null).length;
  } catch {
    return Infinity;
  }
}

/** A bounded string field of a frame, or `null`. */
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** A `view-mount` frame's fields, bounded; `null` when malformed. */
function mountShape(msg: Record<string, unknown>) {
  const fields = {
    vid: str(msg.vid, 64),
    view: str(msg.view, 128),
    token: str(msg.token, 128),
    props: typeof msg.props === "string" ? msg.props : null,
  };
  const resume = msg.resume === undefined ? undefined : str(msg.resume, 64);
  if (Object.values(fields).includes(null) || resume === null) return null;
  if (msg.enc !== undefined && msg.enc !== WIRE_ENC) return null;
  return { ...(fields as Record<keyof typeof fields, string>), resume, enc: msg.enc === WIRE_ENC };
}

/**
 * Build the live-view half of a hub.
 *
 * @param deps The hub primitives.
 * @returns The live-view operations.
 */
export function createLiveViewHub<C extends ViewConn>(deps: ViewHubDeps<C>): ViewHub<C> {
  const parkedViews = new Map<string, Instance<C>>();
  const all = new Set<Instance<C>>();
  const unstorable = new Set<string>();

  /** Queue a store operation for `inst` (in order; a failure is logged, never thrown). */
  const storeOp = (inst: Instance<C>, op: (store: LiveViewStore) => Promise<void>): void => {
    const store = deps.store?.();
    if (!store) return;
    inst.storeChain = inRootContext(() =>
      (inst.storeChain ?? Promise.resolve()).then(() => op(store)).catch((err) => {
        if (err instanceof TypeError && !unstorable.has(inst.def.id)) {
          unstorable.add(inst.def.id);
          console.warn(
            `denext live view ${inst.def.id}: its model is not serializable, so it is parked in ` +
              `this process only (${err.message})`,
          );
        } else if (!(err instanceof TypeError)) {
          console.warn(`denext live view ${inst.def.id}: view store failed:`, err);
        }
      })
    );
  };

  /** Write a parked instance's snapshot to the shared store. */
  const persist = (inst: Instance<C>): void => {
    const ttl = deps.limits().viewResumeSeconds;
    const snapshot = { view: inst.def.id, signed: inst.signed, model: inst.engine.model };
    storeOp(inst, async (store) => {
      await store.set(inst.iid, await sealViewSnapshot(inst.iid, snapshot), ttl);
    });
  };

  const own = (conn: C, vid: string): Instance<C> | undefined =>
    conn.views.get(vid) as Instance<C> | undefined;

  const stop = (inst: Instance<C>): void => {
    if (inst.stopped) return;
    inst.stopped = true;
    inst.engine.stop();
    if (inst.parkTimer !== undefined) clearTimeout(inst.parkTimer);
    inst.parkTimer = undefined;
    parkedViews.delete(inst.iid);
    all.delete(inst);
    if (inst.attached && inst.owner.views.get(inst.vid) === inst) inst.owner.views.delete(inst.vid);
    inst.tables.clear();
    inst.flight = null;
  };

  /** End a view and tell its client why (the client stops re-mounting it). */
  const end = (inst: Instance<C>, code: LiveError["code"], reason: string): void => {
    if (inst.attached && deps.isConnected(inst.owner)) {
      deps.sendError(inst.owner, code, reason, { subId: inst.vid });
    }
    stop(inst);
  };

  const fail = (inst: Instance<C>, err: unknown): void => {
    const client = toClientError(err);
    if (inst.attached && deps.isConnected(inst.owner)) {
      deps.sendError(inst.owner, "failed", client.message, {
        subId: inst.vid,
        ...(client.digest ? { digest: client.digest } : {}),
      });
    }
  };

  const bytesHeld = (conn: C, except?: Instance<C>): number => {
    let total = 0;
    for (const v of conn.views.values()) {
      if (v === except) continue;
      const i = v as Instance<C>;
      total += i.modelBytes + i.flightBytes;
    }
    return total;
  };

  const overBudget = (inst: Instance<C>, modelBytes: number, flightBytes: number): boolean =>
    bytesHeld(inst.owner, inst) + modelBytes + flightBytes >
      deps.limits().maxViewBytesPerConnection;

  const authorize = async (inst: { def: LiveViewDef; props: unknown }, conn: C) => {
    if (!inst.def.authorize) return true;
    try {
      return await deps.withConnContext(
        conn,
        () => inst.def.authorize!(inst.props, { connection: deps.connContext(conn) }),
      ) === true;
    } catch {
      return false;
    }
  };

  const ttlMs = () => deps.limits().channelAuthTtlSeconds * 1000;

  const sendWhole = (inst: Instance<C>): void => {
    const conn = inst.owner;
    if (!inst.flight) return;
    if (deps.backPressured(conn)) return holdBack(inst);
    inst.needsFull = false;
    const frame: LiveServerMessage = {
      type: "view-render",
      vid: inst.vid,
      rev: inst.rev,
      flight: inst.flight,
      iid: inst.iid,
    };
    deps.sendFrame(conn, JSON.stringify(frame), frame);
  };

  const holdBack = (inst: Instance<C>): void => {
    inst.needsFull = true;
    (inst.owner.recoverViews ??= new Set()).add(inst.vid);
    deps.armRecover(inst.owner);
  };

  const renderOnce = async (inst: Instance<C>): Promise<void> => {
    const conn = inst.owner;
    const { send, table } = createHandlerTable<unknown>();
    const root = await deps.render(
      conn,
      () => renderToFlight(inst.def.view(inst.engine.model, send)),
    );
    if (inst.stopped || !inst.attached || inst.owner !== conn) return;
    const flight = Array.isArray(root) ? root : [root];
    const text = JSON.stringify(flight);
    if (overBudget(inst, inst.modelBytes, text.length)) {
      return end(inst, "limit", "view state too large");
    }
    const prev = inst.flight;
    inst.flightBytes = text.length;
    inst.flight = flight;
    if (prev && !inst.needsFull) return sendChanges(inst, prev, table, text.length);
    advance(inst, table);
    sendWhole(inst);
  };

  /** Send the diff from `prev` to the new render — or the whole tree when that is smaller. */
  const sendChanges = (
    inst: Instance<C>,
    prev: FlightNode[],
    table: MsgSource<unknown>[],
    wholeBytes: number,
  ): void => {
    const ops = diffFlight(prev, inst.flight!);
    if (ops.length === 0) {
      inst.tables.set(inst.rev, table); // the same tree: the same handlers, re-recorded
      return;
    }
    const base = inst.rev;
    advance(inst, table);
    const frame: LiveServerMessage = {
      type: "view-patch",
      vid: inst.vid,
      base,
      rev: inst.rev,
      ops,
    };
    const text = JSON.stringify(frame);
    if (text.length >= wholeBytes) return sendWhole(inst);
    if (deps.backPressured(inst.owner)) return holdBack(inst);
    deps.sendFrame(inst.owner, text, frame);
  };

  const advance = (inst: Instance<C>, table: MsgSource<unknown>[]): void => {
    inst.rev++;
    inst.tables.set(inst.rev, table);
    inst.tables.delete(inst.rev - HANDLER_HISTORY);
  };

  const scheduleRender = (inst: Instance<C>): void => {
    if (inst.stopped) return;
    if (!inst.attached) {
      inst.needsFull = true; // rendered on resume
      return;
    }
    if (inst.rendering) {
      inst.dirty = true;
      return;
    }
    inst.rendering = true;
    void (async () => {
      try {
        do {
          inst.dirty = false;
          try {
            await renderOnce(inst);
          } catch (err) {
            fail(inst, err); // the client keeps the last tree; the next update re-renders
          }
        } while (inst.dirty && !inst.stopped && inst.attached);
      } finally {
        inst.rendering = false;
      }
    })();
  };

  const host = (inst: () => Instance<C>): MvuHost => ({
    run: (work) => deps.withConnContext(inst().owner, work),
    resolveUrl: (url) => new URL(url, inst().owner.origin).href,
    channel(id, key, onPayload, onError) {
      let done = false;
      let stopTap: (() => void) | null = null;
      const owner = inst().owner;
      deps.withConnContext(owner, () =>
        tapChannelAuthorized(id, key, {
          peerId: owner.peerId,
          onPayload: (payload) => onPayload(payload),
          onEnd: () => onError(new Error(`channel ${id}/${key}: access ended`)),
        })).then((s) => {
          if (done) s();
          else stopTap = s;
        }, onError);
      return () => {
        done = true;
        stopTap?.();
      };
    },
    onError: (err) => console.error(`denext live view ${inst().def.id}:`, err),
    minIntervalMs: MIN_SERVER_INTERVAL_MS,
    maxPending: MAX_VIEW_EFFECTS,
    maxSubscriptions: MAX_VIEW_EFFECTS,
  });

  const create = (
    conn: C,
    vid: string,
    def: LiveViewDef,
    props: unknown,
    signed: string,
    restored?: { model: unknown },
  ): Instance<C> | null => {
    let init;
    try {
      // A model resumed from the store carries on; `init` (and its effects) ran where it began.
      init = restored ? [restored.model] as [unknown] : def.init(props);
    } catch (err) {
      deps.sendError(conn, "failed", toClientError(err).message, { subId: vid });
      return null;
    }
    const modelBytes = modelSize(init?.[0]);
    if (bytesHeld(conn) + modelBytes > deps.limits().maxViewBytesPerConnection) {
      deps.sendError(conn, "limit", "view state too large", { subId: vid });
      return null;
    }
    let self: Instance<C> | null = null;
    const engine = createMvuEngine<unknown, unknown>({
      init,
      update: () => def.update,
      subscriptions: () => def.subscriptions,
      host: host(() => self!),
      onChange: (model) => {
        const inst = self!;
        const bytes = modelSize(model);
        if (overBudget(inst, bytes, inst.flightBytes)) {
          return end(inst, "limit", "view state too large");
        }
        inst.modelBytes = bytes;
        if (!inst.attached && !inst.stopped) persist(inst); // the stored snapshot follows it
        scheduleRender(inst);
      },
      onUpdateError: (err) => {
        console.error(`denext live view ${def.id}: update threw`, err);
        fail(self!, err);
      },
    });
    const inst: Instance<C> = {
      iid: crypto.randomUUID(),
      vid,
      def,
      props,
      signed,
      owner: conn,
      attached: true,
      stopped: false,
      engine,
      rev: 0,
      flight: null,
      flightBytes: 0,
      modelBytes,
      tables: new Map(),
      rendering: false,
      dirty: false,
      needsFull: true,
      inbox: 0,
      chain: Promise.resolve(),
      authExpires: Date.now() + ttlMs(),
    };
    self = inst;
    return inst;
  };

  const attach = (conn: C, vid: string, inst: Instance<C>): void => {
    conn.views.set(vid, inst);
    all.add(inst);
    inst.vid = vid;
    inst.owner = conn;
    inst.attached = true;
    inst.needsFull = true;
    scheduleRender(inst);
  };

  const atCap = (conn: C, vid: string): boolean =>
    !conn.views.has(vid) && conn.views.size >= deps.limits().maxViewsPerConnection;

  /** The mount frame's fields, bounded; `null` when malformed. */
  const decodeProps = (
    text: string,
    enc: boolean,
  ): { ok: true; value: unknown } | { ok: false } => {
    try {
      const parsed = JSON.parse(text);
      return { ok: true, value: enc ? decodeWire(parsed) : parsed };
    } catch {
      return { ok: false };
    }
  };

  /** The event's payload after the built-in check and the view's schema; `null` (answered) if not. */
  const validPayload = async (inst: Instance<C>, raw: unknown): Promise<EventPayload | null> => {
    const payload = checkEventPayload(raw);
    const conn = inst.owner;
    if (payload === null) {
      deps.sendError(conn, "invalid-input", "malformed event payload", { subId: inst.vid });
      return null;
    }
    const schema = inst.def.events;
    if (!schema) return payload;
    if (!isStandardSchema(schema)) {
      throw new TypeError("defineLiveView: `events` is not a Standard Schema");
    }
    const result = await schema["~standard"].validate(payload);
    if (!result.issues) return result.value;
    deps.sendError(conn, "invalid-input", "invalid event payload", {
      subId: inst.vid,
      fieldErrors: fieldErrorsFrom(result.issues),
    });
    return null;
  };

  /** Re-run `authorize` once its TTL passed; `false` ended the view. */
  const stillAuthorized = async (inst: Instance<C>): Promise<boolean> => {
    if (Date.now() < inst.authExpires) return true;
    if (!(await authorize(inst, inst.owner))) {
      end(inst, "denied", "view not permitted");
      return false;
    }
    inst.authExpires = Date.now() + ttlMs();
    return true;
  };

  /**
   * The message source behind handler `index` of render `rev`. `undefined` when the view is gone,
   * the render is stale (dropped silently) or the index unknown (answered `bad-message`).
   */
  const handlerFor = (
    inst: Instance<C>,
    rev: number,
    index: number,
  ): MsgSource<unknown> | undefined => {
    const table = inst.stopped || !inst.attached ? undefined : inst.tables.get(rev);
    if (!table) return undefined;
    const source = table[index];
    if (source === undefined) {
      deps.sendError(inst.owner, "bad-message", "unknown handler", { subId: inst.vid });
    }
    return source;
  };

  const processEvent = async (
    inst: Instance<C>,
    rev: number,
    index: number,
    rawPayload: unknown,
  ): Promise<void> => {
    const source = handlerFor(inst, rev, index);
    if (source === undefined) return;
    const payload = await validPayload(inst, rawPayload);
    if (payload === null || !(await stillAuthorized(inst)) || inst.stopped) return;
    let msg: unknown;
    try {
      msg = resolveMsg(source, payload);
    } catch (err) {
      return fail(inst, err);
    }
    if (msg !== null) inst.engine.dispatch(msg);
  };

  /**
   * The mount checks before an instance is placed: the view cap, the props size, a registered
   * view with a token over exactly these props, the props decode, `authorize`. `null` (answered)
   * when one fails.
   */
  const admit = async (
    conn: C,
    shape: NonNullable<ReturnType<typeof mountShape>>,
  ): Promise<{ def: LiveViewDef; props: unknown } | null> => {
    const { vid, view, token, props } = shape;
    const refuse = (code: LiveError["code"], reason: string) => {
      deps.sendError(conn, code, reason, { subId: vid });
      return null;
    };
    if (atCap(conn, vid)) return refuse("limit", "too many views");
    if (new TextEncoder().encode(props).byteLength > deps.limits().maxSubscriptionInputBytes) {
      return refuse("limit", "view props too large");
    }
    // An unknown view and a token that doesn't verify answer alike: `gone` (re-render the route).
    const def = getLiveView(view);
    if (!def || !(await verifyLiveViewToken(view, props, token))) {
      return refuse("gone", "view unavailable");
    }
    const decoded = decodeProps(props, shape.enc);
    if (!decoded.ok) return refuse("bad-message", "malformed view props");
    if (!(await authorize({ def, props: decoded.value }, conn))) {
      return refuse("denied", "view not permitted");
    }
    return { def, props: decoded.value };
  };

  /** The parked instance `resume` names, when it is this view with these signed props. */
  const takeParked = (
    resume: string | undefined,
    view: string,
    signed: string,
  ): Instance<C> | undefined => {
    const parked = resume === undefined ? undefined : parkedViews.get(resume);
    if (!parked || parked.def.id !== view || parked.signed !== signed || parked.stopped) {
      return undefined;
    }
    parkedViews.delete(parked.iid);
    clearTimeout(parked.parkTimer);
    parked.parkTimer = undefined;
    parked.authExpires = Date.now() + ttlMs();
    storeOp(parked, (store) => store.delete(parked.iid));
    return parked;
  };

  /** The model a stored snapshot of `resume` holds, when it is this view with these props. */
  const takeStored = async (
    resume: string | undefined,
    view: string,
    signed: string,
  ): Promise<{ model: unknown } | undefined> => {
    const store = resume === undefined ? null : deps.store?.();
    if (!store) return undefined;
    let sealed: string | null;
    try {
      sealed = await inRootContext(() => store.take(resume!));
    } catch (err) {
      console.warn(`denext live view ${view}: view store failed:`, err);
      return undefined;
    }
    const snapshot = sealed === null ? null : await openViewSnapshot(resume!, sealed);
    if (!snapshot || snapshot.view !== view || snapshot.signed !== signed) return undefined;
    return { model: snapshot.model };
  };

  /**
   * Put an admitted view on the connection: the instance parked here, else the model a stored
   * snapshot holds, else a fresh `init`.
   */
  const place = async (
    conn: C,
    shape: NonNullable<ReturnType<typeof mountShape>>,
    admitted: { def: LiveViewDef; props: unknown },
  ): Promise<void> => {
    const { vid } = shape;
    const signed = `${shape.view}\0${shape.token}`;
    const parked = takeParked(shape.resume, shape.view, signed);
    // Not parked here: another instance (or this one, before an eviction) may have stored it.
    const restored = parked ? undefined : await takeStored(shape.resume, shape.view, signed);
    if (restored && !deps.isConnected(conn)) return;
    if (restored && atCap(conn, vid)) {
      return deps.sendError(conn, "limit", "too many views", { subId: vid });
    }
    const replaced = own(conn, vid);
    if (replaced) stop(replaced);
    if (parked) return attach(conn, vid, parked);
    const inst = create(conn, vid, admitted.def, admitted.props, signed, restored);
    if (!inst) return;
    attach(conn, vid, inst);
    inst.engine.start();
  };

  return {
    async mount(conn, msg) {
      const shape = mountShape(msg);
      if (!shape) {
        const vid = str(msg.vid, 64);
        if (vid) deps.sendError(conn, "bad-message", "malformed view mount", { subId: vid });
        return;
      }
      const admitted = await admit(conn, shape);
      if (!admitted || !deps.isConnected(conn)) return;
      if (atCap(conn, shape.vid)) {
        return deps.sendError(conn, "limit", "too many views", { subId: shape.vid });
      }
      await place(conn, shape, admitted);
    },

    event(conn, msg) {
      const vid = str(msg.vid, 64);
      if (!vid) return;
      const inst = own(conn, vid);
      if (!inst) return;
      const rev = msg.rev;
      const index = msg.h;
      if (!Number.isInteger(rev) || !Number.isInteger(index) || (index as number) < 0) {
        return deps.sendError(conn, "bad-message", "malformed view event", { subId: vid });
      }
      if (inst.inbox >= MAX_VIEW_INBOX) {
        return deps.sendError(conn, "limit", "too many pending events", { subId: vid });
      }
      inst.inbox++;
      inst.chain = inst.chain
        .then(() => processEvent(inst, rev as number, index as number, msg.payload))
        .catch((err) => {
          console.error(`denext live view ${inst.def.id}: event failed`, err);
          fail(inst, err);
        })
        .finally(() => inst.inbox--);
    },

    unmount(conn, vid) {
      if (typeof vid !== "string") return;
      const inst = own(conn, vid);
      if (inst) stop(inst);
    },

    resync(conn, vid) {
      if (typeof vid !== "string") return;
      const inst = own(conn, vid);
      if (!inst) return;
      inst.needsFull = true;
      if (inst.rendering) inst.dirty = true;
      else sendWhole(inst);
    },

    drop(conn) {
      const { viewResumeSeconds, maxParkedViews } = deps.limits();
      for (const v of [...conn.views.values()]) {
        const inst = v as Instance<C>;
        conn.views.delete(inst.vid);
        inst.attached = false;
        if (inst.stopped) continue;
        parkedViews.set(inst.iid, inst);
        persist(inst);
        // The park timer serves the instance, not the closing socket's handler context.
        inst.parkTimer = inRootContext(() =>
          setTimeout(() => stop(inst), viewResumeSeconds * 1000)
        );
        while (parkedViews.size > maxParkedViews) {
          const oldest = parkedViews.values().next().value as Instance<C>;
          stop(oldest);
        }
      }
      conn.recoverViews = undefined;
    },

    discard(conn) {
      for (const v of [...conn.views.values()]) stop(v as Instance<C>);
      conn.views.clear();
    },

    replayPending(conn) {
      const ids = conn.recoverViews;
      if (!ids) return;
      conn.recoverViews = undefined;
      for (const vid of ids) {
        const inst = own(conn, vid);
        if (!inst) continue;
        inst.needsFull = true;
        if (inst.rendering) inst.dirty = true;
        else sendWhole(inst);
      }
    },

    dispose() {
      for (const inst of [...all]) stop(inst);
      for (const inst of [...parkedViews.values()]) stop(inst);
      parkedViews.clear();
    },

    parked: () => parkedViews.size,
  };
}
