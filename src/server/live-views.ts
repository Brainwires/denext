// The Live hub's live-view half (`defineLiveView`): one server-held Model–View–Update instance per
// mounted view per connection. Built as a factory over the hub's primitives
// (`createLiveViewHub(deps)`), like the channel half, so it never imports `live.ts`.
//
// Every check on `view-mount`, in order: frame shape; the per-connection view cap; the props
// size cap; a registered view and a token the server signed over exactly these props (either
// failing is `gone` — the client re-renders the route for fresh ones, and an attacker learns
// nothing); the props decode; the view's `authorize` in the viewer's session (a throw is a
// deny); a post-await connected + cap re-check. Then a parked instance named by `resume` is
// adopted (same view, same signed props, same viewer — `viewerIdentity`), or `init` runs. The
// props token carries its issue time and is refused past `viewTokenMaxAgeSeconds`; a resume
// matches the props it signs (`resumeKey`), not the token, so a re-signed page still resumes.
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
// snapshot back and resumes the model under a new instance id instead of running `init`. That
// instance announces the resume on the cross-instance bus (`announceResumed`), and the instance
// still holding the parked copy stops it at once (`resumedElsewhere`) — its effects,
// subscriptions and pending store writes with it — instead of running it out its park window.

import type { FlightNode } from "../jsx/render-to-flight.ts";
import { renderToFlight } from "../jsx/render-to-flight.ts";
import { fieldErrorsFrom, isStandardSchema } from "../runtime/define-action.ts";
import { toClientError } from "../runtime/error-boundary.ts";
import { diffFlight } from "../runtime/flight-patch.ts";
import type { LiveError, LiveServerMessage } from "../runtime/live-protocol.ts";
import { createHandlerTable, getLiveView, type LiveViewDef } from "../runtime/live-view.ts";
import {
  createMvuEngine,
  type EventPayload,
  type MsgSource,
  type MvuEngine,
  type MvuHost,
  resolveMsg,
} from "../runtime/mvu.ts";
import { prepareWire } from "../runtime/wire-encode.ts";
import { tapChannelAuthorized } from "./channel-subscriber.ts";
import { inRootContext } from "./root-context.ts";
import {
  type LiveViewStore,
  openViewSnapshot,
  sealViewSnapshot,
  type ViewSnapshot,
} from "./live-view-store.ts";
import { recordViewMessages, type RedactedValue, redactValue } from "./live-devtools.ts";
import {
  authorizeView,
  endView,
  enqueueEvent,
  type MountShape,
  mountView,
  resumeKey,
  str,
  takeParked as takeParkedFrom,
  viewerIdentity,
  type ViewHubBaseDeps,
  type ViewHubFrames,
} from "./view-hub-common.ts";

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
export type { ViewLimits } from "./view-hub-common.ts";

/** What the hub lends this module. */
export interface ViewHubDeps<C extends ViewConn> extends ViewHubBaseDeps<C> {
  /** Run a render: a render slot, the render deadline, the connection's context. */
  render<T>(conn: C, fn: () => Promise<T>): Promise<T>;
  /** The shared store parked views are written to (none: parked in this process only). */
  store?(): LiveViewStore | null;
  /**
   * Tell every instance that the parked view `iid` resumed here from the shared store (the
   * cross-instance bus; each one answers with {@linkcode ViewHub.resumedElsewhere}).
   */
  announceResumed?(iid: string): void;
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
  /** `resumeKey` (view-hub-common.ts): a resume must present the same signed props. */
  readonly signed: string;
  /** The viewer it was mounted for: a resume (here or from the store) must be the same viewer. */
  readonly identity: string;
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
  /** Resumed on another instance: its queued store writes are dropped, never landed. */
  superseded?: boolean;
}

/** The hub's live-view operations. */
export interface ViewHub<C extends ViewConn> extends ViewHubFrames<C> {
  /**
   * The parked view `iid` resumed on another instance (from the shared store): stop the copy
   * parked here, without writing it back. Nothing happens when `iid` is not parked here.
   */
  resumedElsewhere(iid: string): void;
  /** Stop every instance (teardown). */
  dispose(): void;
  /**
   * Resolves once every queued view-store write has landed (or failed and been logged): a
   * parked view's snapshot is still being sealed and written after its socket closed.
   */
  settled(): Promise<void>;
  /** Parked instances (tests, diagnostics). */
  parked(): number;
  /** Every running instance, redacted (the DevTools' Live views tab). */
  inspect(): ViewSummary[];
}

/** One running view, as the DevTools list it (the model redacted). */
export interface ViewSummary {
  /** The view id. */
  view: string;
  /** The instance id. */
  iid: string;
  /** `attached` to a socket, or `parked` waiting for a reconnect. */
  state: "attached" | "parked";
  /** The peer it is attached to (or was, while parked). */
  peer: string;
  /** The render revision. */
  rev: number;
  /** Events waiting to be processed. */
  inbox: number;
  /** JSON size of the model. */
  modelBytes: number;
  /** JSON size of the rendered tree. */
  flightBytes: number;
  /** The model: its structure, every string as `string(n)`. */
  model: RedactedValue;
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

/** Whether a stored snapshot is this view, with these signed props, parked by this viewer. */
function snapshotFits(
  snapshot: ViewSnapshot | null,
  view: string,
  signed: string,
  identity: string,
): snapshot is ViewSnapshot {
  return !!snapshot && snapshot.view === view && snapshot.signed === signed &&
    snapshot.identity === identity;
}

/** The JSON size of a model (wire-codec shaped); `Infinity` when it can't be encoded. */
function modelSize(model: unknown): number {
  try {
    return JSON.stringify(prepareWire(model).value ?? null).length;
  } catch {
    return Infinity;
  }
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
  /** The store chains still running (`settled()` waits for them). */
  const pendingStore = new Set<Promise<void>>();

  /** Queue a store operation for `inst` (in order; a failure is logged, never thrown). */
  const storeOp = (inst: Instance<C>, op: (store: LiveViewStore) => Promise<void>): void => {
    const store = deps.store?.();
    if (!store) return;
    inst.storeChain = inRootContext(() =>
      (inst.storeChain ?? Promise.resolve()).then(() => inst.superseded ? undefined : op(store))
        .catch((err) => {
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
    const chain = inst.storeChain;
    pendingStore.add(chain);
    // The chain never rejects (its `catch` logs), so this tail never does either.
    chain.then(() => pendingStore.delete(chain));
  };

  /** Tell the other instances `iid` resumed here (the one that parked it stops its copy). */
  const announceResumed = (iid: string): void => deps.announceResumed?.(iid);

  /** Write a parked instance's snapshot to the shared store. */
  const persist = (inst: Instance<C>): void => {
    const ttl = deps.limits().viewResumeSeconds;
    const snapshot = {
      view: inst.def.id,
      signed: inst.signed,
      identity: inst.identity,
      model: inst.engine.model,
    };
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
  const end = (inst: Instance<C>, code: LiveError["code"], reason: string): void =>
    endView(deps, inst, code, reason, () => stop(inst));

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

  const authorize = (inst: { def: LiveViewDef; props: unknown }, conn: C) =>
    authorizeView(deps, conn, inst.def.authorize, inst.props);

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
    identity: string,
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
      onChange: (model, msgs) => {
        const inst = self!;
        const bytes = modelSize(model);
        if (overBudget(inst, bytes, inst.flightBytes)) {
          return end(inst, "limit", "view state too large");
        }
        inst.modelBytes = bytes;
        recordViewMessages(def.id, inst.iid, msgs);
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
      identity,
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

  /** The mount checks (view-hub-common.ts `admitView`), with this half's registry. */
  const policy = (conn: C) => ({
    atCap: (vid: string) => atCap(conn, vid),
    lookup: getLiveView,
    tokenName: (view: string) => view,
    authorize: (def: LiveViewDef, props: unknown) => authorize({ def, props }, conn),
  });

  /** The parked instance `resume` names, when it is this view with these signed props and viewer. */
  const takeParked = (
    resume: string | undefined,
    view: string,
    signed: string,
    identity: string,
  ): Instance<C> | undefined => {
    const parked = takeParkedFrom(parkedViews, resume, view, signed, identity);
    if (!parked) return undefined;
    parked.authExpires = Date.now() + ttlMs();
    storeOp(parked, (store) => store.delete(parked.iid));
    return parked;
  };

  /**
   * The model a stored snapshot of `resume` holds, when it is this view with these props, parked
   * by the same viewer. Another viewer's take still consumes the snapshot (it runs `init`).
   */
  const takeStored = async (
    resume: string | undefined,
    view: string,
    signed: string,
    identity: string,
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
    if (!snapshotFits(snapshot, view, signed, identity)) return undefined;
    // The instance that parked it may still run its copy: it stops it on hearing this.
    announceResumed(resume!);
    return { model: snapshot.model };
  };

  /** What a mount resumes: the instance parked here, else the model a stored snapshot holds. */
  const resumeOf = async (shape: MountShape, signed: string, identity: string) => {
    const parked = takeParked(shape.resume, shape.view, signed, identity);
    // Not parked here: another instance (or this one, before an eviction) may have stored it.
    if (parked) return { parked, restored: undefined };
    return { parked, restored: await takeStored(shape.resume, shape.view, signed, identity) };
  };

  /**
   * Put an admitted view on the connection: the instance parked here, else the model a stored
   * snapshot holds, else a fresh `init`.
   */
  const place = async (
    conn: C,
    shape: MountShape,
    admitted: { def: LiveViewDef; props: unknown },
  ): Promise<void> => {
    const { vid } = shape;
    const signed = await resumeKey(shape.view, shape.props);
    const identity = await viewerIdentity(deps, conn);
    if (!deps.isConnected(conn)) return;
    const { parked, restored } = await resumeOf(shape, signed, identity);
    if (restored && !deps.isConnected(conn)) return;
    if (restored && atCap(conn, vid)) {
      return deps.sendError(conn, "limit", "too many views", { subId: vid });
    }
    const replaced = own(conn, vid);
    if (replaced) stop(replaced);
    if (parked) return attach(conn, vid, parked);
    const inst = create(conn, vid, admitted.def, admitted.props, signed, identity, restored);
    if (!inst) return;
    attach(conn, vid, inst);
    inst.engine.start();
  };

  return {
    mount(conn, msg) {
      return mountView(
        deps,
        conn,
        msg,
        policy(conn),
        (shape, admitted) => place(conn, shape, admitted),
      );
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
      enqueueEvent(
        deps,
        conn,
        vid,
        inst,
        MAX_VIEW_INBOX,
        () => processEvent(inst, rev as number, index as number, msg.payload),
        (err) => {
          console.error(`denext live view ${inst.def.id}: event failed`, err);
          fail(inst, err);
        },
      );
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

    resumedElsewhere(iid) {
      const inst = parkedViews.get(iid);
      if (!inst || inst.attached) return;
      inst.superseded = true;
      stop(inst);
    },

    dispose() {
      for (const inst of [...all]) stop(inst);
      for (const inst of [...parkedViews.values()]) stop(inst);
      parkedViews.clear();
    },

    async settled() {
      while (pendingStore.size > 0) await Promise.all(pendingStore);
    },

    parked: () => parkedViews.size,

    inspect: () =>
      [...all].map((inst) => ({
        view: inst.def.id,
        iid: inst.iid,
        state: inst.attached ? "attached" as const : "parked" as const,
        peer: inst.owner.peerId,
        rev: inst.rev,
        inbox: inst.inbox,
        modelBytes: inst.modelBytes,
        flightBytes: inst.flightBytes,
        model: redactValue(inst.engine.model),
      })),
  };
}
