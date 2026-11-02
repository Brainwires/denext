// What the Live hub's two server-held view halves share: `defineLiveView` (live-views.ts) and
// `defineLustreView` (lustre-views.ts). Both mount a view from a signed props token, gate it with
// `authorize`, take a parked instance back on a resume and queue events in a bounded inbox; only
// what runs inside differs (an MVU engine, a Lustre runtime). These are the frame-level steps they
// run the same way, so a guard fixed here is fixed for both.

import type { LiveError, LiveServerMessage } from "../runtime/live-protocol.ts";
import { verifyLiveViewToken } from "../runtime/live-view.ts";
import { decodeWire, WIRE_ENC } from "../runtime/wire-codec.ts";
import { sha256Hex } from "./auth/hash.ts";
import { auth, peekActiveAuthConfig } from "./auth/mod.ts";

/** The caps a view hub reads (a subset of `live.limits`). */
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
  /** Seconds before `authorize` runs again. */
  channelAuthTtlSeconds: number;
  /** Seconds a view's signed props token is accepted after the page rendered it. */
  viewTokenMaxAgeSeconds: number;
  /**
   * Seconds one mount (its token check, `authorize`, the viewer's identity, the resume) may hold
   * its connection's mount queue before it is refused with `failed` and the next mount runs: the
   * Live render deadline (`renderTimeoutSeconds`). Default 30.
   */
  renderTimeoutSeconds?: number;
}

/** What the Live hub lends a view half. */
export interface ViewHubBaseDeps<C> {
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
  /** Is the socket back-pressured right now? */
  backPressured(conn: C): boolean;
  /** Arm the hub's drain-recovery timer for `conn`. */
  armRecover(conn: C): void;
}

/** The frame handlers both view halves expose to the Live hub. */
export interface ViewHubFrames<C> {
  /** Handle a mount frame. */
  mount(conn: C, msg: Record<string, unknown>): Promise<void>;
  /** Handle an event frame. */
  event(conn: C, msg: Record<string, unknown>): void;
  /** Handle an unmount frame. */
  unmount(conn: C, vid: unknown): void;
  /** Handle a resync frame (send the whole view again). */
  resync(conn: C, vid: unknown): void;
  /** Park every view of a closing connection. */
  drop(conn: C): void;
  /** Stop every view of a connection without parking it (the hub is shutting down). */
  discard(conn: C): void;
  /** Re-send the views whose frames a back-pressured socket held back (the socket drained). */
  replayPending(conn: C): void;
}

/** A bounded string field of a frame, or `null`. */
export function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** A mount frame's fields, bounded; `null` when malformed. */
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

/** A well-formed mount frame. */
export type MountShape = NonNullable<ReturnType<typeof mountShape>>;

/** The props JSON a mount carries, decoded (wire-codec tags too when `enc`). */
function decodeProps(text: string, enc: boolean): { ok: true; value: unknown } | { ok: false } {
  try {
    const parsed = JSON.parse(text);
    return { ok: true, value: enc ? decodeWire(parsed) : parsed };
  } catch {
    return { ok: false };
  }
}

/**
 * Run a view's `authorize` in the viewer's session. A missing one allows; a throw denies.
 *
 * @param deps The hub primitives.
 * @param conn The connection.
 * @param authorize The view's gate.
 * @param props The view's props.
 * @returns Whether the viewer may have the view.
 */
export async function authorizeView<C, P>(
  deps: ViewHubBaseDeps<C>,
  conn: C,
  authorize:
    | ((props: P, ctx: { connection: ReturnType<typeof deps.connContext> }) => unknown)
    | undefined,
  props: P,
): Promise<boolean> {
  if (!authorize) return true;
  try {
    return await deps.withConnContext(
      conn,
      () => authorize(props, { connection: deps.connContext(conn) }),
    ) === true;
  } catch {
    return false;
  }
}

/** How a view half looks up and gates a mount (see {@link admitView}). */
export interface AdmitPolicy<D> {
  /** Is the connection at its view cap (for this view id)? */
  atCap(vid: string): boolean;
  /** The registered view with this id. */
  lookup(view: string): D | undefined;
  /** The name the view's props token is signed under. */
  tokenName(view: string): string;
  /** The view's `authorize`, in the viewer's session. */
  authorize(def: D, props: unknown): Promise<boolean>;
}

/**
 * The mount checks before an instance is placed, in order: the view cap, the props size, a
 * registered view with a token over exactly these props (an unknown view and a bad token answer
 * alike, `gone`), the props decode, `authorize`. `null` (answered) when one fails.
 *
 * @param deps The hub primitives.
 * @param conn The connection.
 * @param shape The mount frame.
 * @param policy The view half's lookups.
 * @param ticket The mount's place in its queue: a cancelled mount's refusal is not answered.
 * @returns The view and its decoded props, or `null`.
 */
async function admitView<C, D>(
  deps: ViewHubBaseDeps<C>,
  conn: C,
  shape: MountShape,
  policy: AdmitPolicy<D>,
  ticket: MountTicket,
): Promise<{ def: D; props: unknown } | null> {
  const { vid, view, token, props } = shape;
  const refuse = (code: LiveError["code"], reason: string) => {
    if (!ticket.cancelled) deps.sendError(conn, code, reason, { subId: vid });
    return null;
  };
  if (policy.atCap(vid)) return refuse("limit", "too many views");
  if (new TextEncoder().encode(props).byteLength > deps.limits().maxSubscriptionInputBytes) {
    return refuse("limit", "view props too large");
  }
  const def = policy.lookup(view);
  const maxAge = deps.limits().viewTokenMaxAgeSeconds;
  if (!def || !(await verifyLiveViewToken(policy.tokenName(view), props, token, maxAge))) {
    return refuse("gone", "view unavailable");
  }
  const decoded = decodeProps(props, shape.enc);
  if (!decoded.ok) return refuse("bad-message", "malformed view props");
  if (!(await policy.authorize(def, decoded.value))) return refuse("denied", "view not permitted");
  return { def, props: decoded.value };
}

/** A mount in a connection's queue: `cancelled` once an unmount, a close or its deadline ends it. */
interface MountTicket {
  /** The view id the frame names (`null` when it names none). */
  readonly vid: string | null;
  /** Ended before it was placed: it places nothing and answers nothing more. */
  cancelled: boolean;
}

/** A connection's mount queue: its tail and the mounts waiting in it or running. */
interface QueueState {
  tail: Promise<void>;
  tickets: Set<MountTicket>;
}

/** Seconds a mount may hold its connection's queue when `renderTimeoutSeconds` is not set. */
const DEFAULT_MOUNT_TIMEOUT_SECONDS = 30;

/**
 * Put an admitted view on the connection. `live` turns false once the mount was cancelled or the
 * connection closed: check it after each of its own awaits.
 */
export type PlaceView<C, D> = (
  conn: C,
  shape: MountShape,
  admitted: { def: D; props: unknown },
  live: () => boolean,
) => void | Promise<void>;

/** Each connection's mounts, first come first placed (see {@link createMountQueue}). */
export interface MountQueue<C> {
  /**
   * Handle a mount frame ({@link mountView}) once every earlier mount of `conn` settled (placed,
   * refused, cancelled or timed out). A mount cancelled while it waits never runs.
   */
  mount<D>(
    conn: C,
    msg: Record<string, unknown>,
    policy: AdmitPolicy<D>,
    place: PlaceView<C, D>,
  ): Promise<void>;
  /** Cancel `conn`'s waiting and running mounts: those of view id `vid`, or every one. */
  cancel(conn: C, vid?: string): void;
}

/**
 * The per-connection mount queue of a view hub. Every await of a mount (the token check,
 * `authorize`, the viewer's identity, the resume digest and store) runs before it is placed, so
 * without it a later mount on the same connection could overtake an earlier one and take its
 * slot under the view cap. Mounts of one connection run one at a time, in arrival order; other
 * connections' mounts run concurrently. Each holds the queue at most `renderTimeoutSeconds`: past
 * it the mount is cancelled (it places nothing, even when its `authorize` settles later) and
 * answered `failed`, and the next one runs.
 *
 * @param deps The hub primitives.
 * @returns The queue.
 */
export function createMountQueue<C extends object>(deps: ViewHubBaseDeps<C>): MountQueue<C> {
  const queues = new WeakMap<C, QueueState>();

  const bounded = async (conn: C, ticket: MountTicket, work: Promise<void>): Promise<void> => {
    const seconds = deps.limits().renderTimeoutSeconds ?? DEFAULT_MOUNT_TIMEOUT_SECONDS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), seconds * 1000);
    });
    try {
      if ((await Promise.race([work, expired])) !== "timeout" || ticket.cancelled) return;
    } finally {
      clearTimeout(timer);
    }
    ticket.cancelled = true;
    if (ticket.vid !== null && deps.isConnected(conn)) {
      deps.sendError(conn, "failed", "view mount timed out", { subId: ticket.vid });
    }
  };

  return {
    mount(conn, msg, policy, place) {
      let state = queues.get(conn);
      if (!state) queues.set(conn, state = { tail: Promise.resolve(), tickets: new Set() });
      const queue = state;
      const ticket: MountTicket = { vid: str(msg.vid, 64), cancelled: false };
      queue.tickets.add(ticket);
      const turn = queue.tail.then(() =>
        ticket.cancelled
          ? undefined
          : bounded(conn, ticket, mountView(deps, conn, msg, ticket, policy, place))
      );
      const tail = turn.then(() => {}, () => {});
      queue.tail = tail;
      return turn.finally(() => {
        queue.tickets.delete(ticket);
        if (queue.tail === tail) queues.delete(conn);
      });
    },

    cancel(conn, vid) {
      for (const ticket of queues.get(conn)?.tickets ?? []) {
        if (vid === undefined || ticket.vid === vid) ticket.cancelled = true;
      }
    },
  };
}

/**
 * A mount frame end to end: its shape (a malformed one is `bad-message` when it names a view id),
 * {@link admitView}, a post-await connected and cap re-check, then `place`. The hub's
 * {@link MountQueue} runs it, with the mount's `ticket`.
 *
 * @param deps The hub primitives.
 * @param conn The connection.
 * @param msg The frame.
 * @param ticket The mount's place in its connection's queue.
 * @param policy The view half's lookups.
 * @param place Put the admitted view on the connection.
 */
async function mountView<C, D>(
  deps: ViewHubBaseDeps<C>,
  conn: C,
  msg: Record<string, unknown>,
  ticket: MountTicket,
  policy: AdmitPolicy<D>,
  place: PlaceView<C, D>,
): Promise<void> {
  const shape = mountShape(msg);
  if (!shape) {
    const vid = str(msg.vid, 64);
    if (vid) deps.sendError(conn, "bad-message", "malformed view mount", { subId: vid });
    return;
  }
  const live = () => !ticket.cancelled && deps.isConnected(conn);
  const admitted = await admitView(deps, conn, shape, policy, ticket);
  if (!admitted || !live()) return;
  if (policy.atCap(shape.vid)) {
    return deps.sendError(conn, "limit", "too many views", { subId: shape.vid });
  }
  await place(conn, shape, admitted, live);
}

/**
 * Who a connection's viewer is, for binding a parked view to it: `user:<id>` for a `denextAuth`
 * session (`auth()`, run in the connection's session as `authorize` is), `anonymous` when signed
 * out; without `denextAuth`, a digest of the connection's `Cookie` header (`anonymous` with none),
 * so signing out or switching account changes it whatever session library the app uses. A failure
 * to read it yields a value no other connection has: nothing resumes across it.
 *
 * @param deps The hub primitives.
 * @param conn The connection.
 * @returns The identity fingerprint.
 */
export async function viewerIdentity<C>(deps: ViewHubBaseDeps<C>, conn: C): Promise<string> {
  try {
    return await deps.withConnContext(conn, async () => {
      if (peekActiveAuthConfig()) {
        const session = await auth();
        return session ? `user:${session.user.id}` : "anonymous";
      }
      const cookie = deps.connContext(conn).cookie;
      return cookie ? `cookie:${await sha256Hex(cookie)}` : "anonymous";
    });
  } catch {
    return `unknown:${crypto.randomUUID()}`;
  }
}

/**
 * What a resume matches a parked or stored view on besides its viewer: the view id and a digest
 * of the props text its token signs (`view + "\0" + SHA-256(props)`). Call it only after the
 * mount's token verified (signature and age), so the props are ones the server signed. It leaves
 * the token itself out: a page that re-rendered (a soft navigation back, an ISR re-render, a
 * re-render after an expired token's `gone`) carries a freshly issued token over the same props,
 * and still resumes its model.
 *
 * @param view The view id.
 * @param props The props text the verified token signs.
 * @returns The resume key.
 */
export async function resumeKey(view: string, props: string): Promise<string> {
  return `${view}\0${await sha256Hex(props)}`;
}

/** What a parked instance carries that a resume checks. */
export interface Parkable {
  /** The instance id. */
  readonly iid: string;
  /** The view. */
  readonly def: { readonly id: string };
  /** {@link resumeKey}: the view and the props its verified token signs. */
  readonly signed: string;
  /** The viewer it was mounted for ({@link viewerIdentity}): only the same viewer resumes it. */
  readonly identity: string;
  /** Stopped for good. */
  stopped: boolean;
  /** The timer that stops it at the end of its resume window. */
  parkTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The instance parked under `resume`, when it is this view with the same signed props (whatever
 * token the page now carries over them), mounted for the same viewer: taken out of `parked`, its park timer cleared. Another viewer's resume (signed
 * out, or another account, on the same page) gets `undefined` and the instance stays parked.
 *
 * @param parked The parked instances by id.
 * @param resume The id the client resumes.
 * @param view The view id.
 * @param signed The mount's {@link resumeKey}.
 * @param identity The resuming connection's {@link viewerIdentity}.
 * @returns The instance, or `undefined`.
 */
export function takeParked<I extends Parkable>(
  parked: Map<string, I>,
  resume: string | undefined,
  view: string,
  signed: string,
  identity: string,
): I | undefined {
  const inst = resume === undefined ? undefined : parked.get(resume);
  if (!inst || inst.def.id !== view || inst.signed !== signed || inst.stopped) return undefined;
  if (inst.identity !== identity) return undefined;
  parked.delete(inst.iid);
  clearTimeout(inst.parkTimer);
  inst.parkTimer = undefined;
  return inst;
}

/** An instance with an event inbox. */
export interface Inboxed {
  /** Events waiting. */
  inbox: number;
  /** The tail of the event chain. */
  chain: Promise<void>;
}

/**
 * Queue an event's work behind the instance's earlier ones, refusing it (`limit`) past `max`
 * waiting. A throw from `work` goes to `onError`.
 *
 * @param deps The hub primitives.
 * @param conn The connection.
 * @param vid The view id (the error's `subId`).
 * @param inst The instance.
 * @param max The inbox cap.
 * @param work The event's processing.
 * @param onError Where a throw goes.
 */
export function enqueueEvent<C>(
  deps: ViewHubBaseDeps<C>,
  conn: C,
  vid: string,
  inst: Inboxed,
  max: number,
  work: () => Promise<void>,
  onError: (err: unknown) => void,
): void {
  if (inst.inbox >= max) {
    return deps.sendError(conn, "limit", "too many pending events", { subId: vid });
  }
  inst.inbox++;
  inst.chain = inst.chain.then(work).catch(onError).finally(() => inst.inbox--);
}

/** An instance as attached to a connection. */
export interface Attached<C> {
  /** On a connection now (not parked). */
  attached: boolean;
  /** The connection it is (or was last) attached to. */
  owner: C;
  /** Its view id there. */
  vid: string;
}

/**
 * End a view and tell its client why (the client stops re-mounting it), then `stop` it.
 *
 * @param deps The hub primitives.
 * @param inst The instance.
 * @param code The error code.
 * @param reason The reason.
 * @param stop Stops the instance.
 */
export function endView<C>(
  deps: ViewHubBaseDeps<C>,
  inst: Attached<C>,
  code: LiveError["code"],
  reason: string,
  stop: () => void,
): void {
  if (inst.attached && deps.isConnected(inst.owner)) {
    deps.sendError(inst.owner, code, reason, { subId: inst.vid });
  }
  stop();
}
