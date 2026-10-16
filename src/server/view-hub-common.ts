// What the Live hub's two server-held view halves share: `defineLiveView` (live-views.ts) and
// `defineLustreView` (lustre-views.ts). Both mount a view from a signed props token, gate it with
// `authorize`, take a parked instance back on a resume and queue events in a bounded inbox; only
// what runs inside differs (an MVU engine, a Lustre runtime). These are the frame-level steps they
// run the same way, so a guard fixed here is fixed for both.

import type { LiveError, LiveServerMessage } from "../runtime/live-protocol.ts";
import { verifyLiveViewToken } from "../runtime/live-view.ts";
import { decodeWire, WIRE_ENC } from "../runtime/wire-codec.ts";

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
 * @returns The view and its decoded props, or `null`.
 */
async function admitView<C, D>(
  deps: ViewHubBaseDeps<C>,
  conn: C,
  shape: MountShape,
  policy: AdmitPolicy<D>,
): Promise<{ def: D; props: unknown } | null> {
  const { vid, view, token, props } = shape;
  const refuse = (code: LiveError["code"], reason: string) => {
    deps.sendError(conn, code, reason, { subId: vid });
    return null;
  };
  if (policy.atCap(vid)) return refuse("limit", "too many views");
  if (new TextEncoder().encode(props).byteLength > deps.limits().maxSubscriptionInputBytes) {
    return refuse("limit", "view props too large");
  }
  const def = policy.lookup(view);
  if (!def || !(await verifyLiveViewToken(policy.tokenName(view), props, token))) {
    return refuse("gone", "view unavailable");
  }
  const decoded = decodeProps(props, shape.enc);
  if (!decoded.ok) return refuse("bad-message", "malformed view props");
  if (!(await policy.authorize(def, decoded.value))) return refuse("denied", "view not permitted");
  return { def, props: decoded.value };
}

/**
 * A mount frame end to end: its shape (a malformed one is `bad-message` when it names a view id),
 * {@link admitView}, a post-await connected and cap re-check, then `place`.
 *
 * @param deps The hub primitives.
 * @param conn The connection.
 * @param msg The frame.
 * @param policy The view half's lookups.
 * @param place Put the admitted view on the connection.
 */
export async function mountView<C, D>(
  deps: ViewHubBaseDeps<C>,
  conn: C,
  msg: Record<string, unknown>,
  policy: AdmitPolicy<D>,
  place: (shape: MountShape, admitted: { def: D; props: unknown }) => void | Promise<void>,
): Promise<void> {
  const shape = mountShape(msg);
  if (!shape) {
    const vid = str(msg.vid, 64);
    if (vid) deps.sendError(conn, "bad-message", "malformed view mount", { subId: vid });
    return;
  }
  const admitted = await admitView(deps, conn, shape, policy);
  if (!admitted || !deps.isConnected(conn)) return;
  if (policy.atCap(shape.vid)) {
    return deps.sendError(conn, "limit", "too many views", { subId: shape.vid });
  }
  await place(shape, admitted);
}

/** What a parked instance carries that a resume checks. */
export interface Parkable {
  /** The instance id. */
  readonly iid: string;
  /** The view. */
  readonly def: { readonly id: string };
  /** `view + "\0" + token`. */
  readonly signed: string;
  /** Stopped for good. */
  stopped: boolean;
  /** The timer that stops it at the end of its resume window. */
  parkTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The instance parked under `resume`, when it is this view with these signed props: taken out of
 * `parked`, its park timer cleared.
 *
 * @param parked The parked instances by id.
 * @param resume The id the client resumes.
 * @param view The view id.
 * @param signed `view + "\0" + token`.
 * @returns The instance, or `undefined`.
 */
export function takeParked<I extends Parkable>(
  parked: Map<string, I>,
  resume: string | undefined,
  view: string,
  signed: string,
): I | undefined {
  const inst = resume === undefined ? undefined : parked.get(resume);
  if (!inst || inst.def.id !== view || inst.signed !== signed || inst.stopped) return undefined;
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
