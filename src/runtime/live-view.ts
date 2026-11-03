// `defineLiveView` — a Model–View–Update program whose state lives on the server, per Live
// connection (Phoenix LiveView, Lustre server components).
//
//   // app/counter-view.ts (server-only module)
//   import { defineLiveView } from "denext/live";
//   export const CounterView = defineLiveView({
//     id: "counter",
//     init: (props: { start: number }) => [{ n: props.start }],
//     update: (msg: { type: "inc" }, m) => [{ n: m.n + 1 }],
//     view: (m, send) => <button type="button" onClick={send({ type: "inc" })}>{m.n}</button>,
//   });
//
//   // app/page.tsx (a Server Component)
//   export default function Page() {
//     return <CounterView start={1} />;
//   }
//
// The component renders `view(init(props))` into the page's HTML (so the first paint works with
// JavaScript disabled) inside the framework's `denext#LiveView` island, together with the props
// and an HMAC over them. In the browser the island mounts the view over the Live socket: the
// server runs `init` again for this connection, keeps the model, and answers each event bound
// with `send(…)` by running `update`, its effects, and a re-render whose Flight diff goes back as
// a patch. `send(msg)` never puts the message on the wire: the page only carries the handler's
// index, and the server maps it back to the message it rendered (a client can trigger only
// messages the server rendered for it). The event's payload (an input's value, a key, a form's
// fields) is validated before a `send((payload) => msg)` function sees it.
//
// This module is isomorphic and small; the per-connection runtime is `src/server/live-views.ts`.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import type { StandardSchemaV1 } from "./define-action.ts";
import type { EventBinding, EventPayload, MsgSource, MvuProgram, Send } from "./mvu.ts";
import { WIRE_ENC } from "./wire-codec.ts";
import { prepareWire } from "./wire-encode.ts";
import { LiveViewIsland } from "../client/live-view-island.ts";
import { processShared } from "./process-shared.ts";

/** The connection a live view runs for (`null` for the server render of the page). */
export interface LiveViewContext {
  /** The Live connection's identity; `null` while the page itself renders. */
  connection: { origin: string; url: string; cookie: string; peerId: string } | null;
}

/** What {@link defineLiveView} takes: a program, its id, and its gates. */
export interface LiveViewConfig<Model, Msg, Props> extends MvuProgram<Model, Msg, Props> {
  /** A stable id, unique in the app (the browser mounts the view by it). */
  id: string;
  /**
   * May this viewer see the view with these props? Runs in the viewer's session (so
   * `getSession()` / `auth()` work) when the page renders, when the browser mounts or resumes the
   * view, and again before an event once `live.limits.channelAuthTtlSeconds` has passed. `false`
   * renders nothing on the page and ends the view on the socket (`denied`). Without it, any
   * viewer holding the page's signed props (until they expire,
   * `live.limits.viewTokenMaxAgeSeconds`) may mount the view; `denext dev` warns once per view
   * that has none.
   */
  authorize?: (props: Props, ctx: LiveViewContext) => boolean | Promise<boolean>;
  /**
   * Validates every event's payload (after the built-in shape check) before a
   * `send((payload) => msg)` function sees it. A rejected payload is an `invalid-input` error and
   * no message is dispatched.
   */
  events?: StandardSchemaV1<EventPayload>;
}

/** The component {@link defineLiveView} returns. */
export interface LiveViewComponent<Props> {
  /** Render the view with `props` (what `init` receives). */
  (props: Props): Promise<VNode | null>;
  /** The view's id. */
  readonly denextLiveViewId: string;
}

/** What the hub needs from a registered view (the config, untyped). */
export type LiveViewDef = LiveViewConfig<unknown, unknown, unknown>;

/** Every live view by id, shared by every copy of this module (see process-shared.ts). */
const views = /* @__PURE__ */ processShared("liveViews", () => new Map<string, LiveViewDef>());

/**
 * The view registered under `id` (the hub mounts by it).
 *
 * @param id The view id.
 * @returns The definition, or `undefined` when no module defining it has loaded.
 */
export function getLiveView(id: string): LiveViewDef | undefined {
  return views.get(id);
}

/** The prop key a rendered `send(…)` handler carries its index under (`{ __dnxlv: index }`). */
const LIVE_VIEW_HANDLER = "__dnxlv";

/**
 * A `send` that records each message source in a table and returns its index as a handler
 * reference. One table per render: the server maps an event's index back to the source.
 *
 * @returns The `send` and its table.
 */
export function createHandlerTable<Msg>(): { send: Send<Msg>; table: MsgSource<Msg>[] } {
  const table: MsgSource<Msg>[] = [];
  const send: Send<Msg> = (source) => {
    table.push(source);
    return { [LIVE_VIEW_HANDLER]: table.length - 1 } as unknown as EventBinding;
  };
  return { send, table };
}

/** The MAC domain of a live view's props token (v2: the token carries its issue time). */
const TOKEN_DOMAIN = "denext.liveview.v2";

/** The environment variable that sets the live-view secret for every instance. */
export const LIVE_VIEW_SECRET_ENV = "DENEXT_LIVE_VIEW_SECRET";

/** The shortest secret the environment may set (as for `DENEXT_ACTION_ID_SECRET`). */
const MIN_SECRET_LENGTH = 16;

/** How long a props token is accepted by default (`live.limits.viewTokenMaxAgeSeconds`). */
export const DEFAULT_VIEW_TOKEN_MAX_AGE_SECONDS = 86_400;

/** How far ahead of this server's clock a token's issue time may be (another instance's skew). */
const TOKEN_CLOCK_SKEW_SECONDS = 300;

/**
 * The key live-view tokens are signed with, and the shared view store's snapshots are sealed
 * under: `DENEXT_LIVE_VIEW_SECRET` (shared by every instance behind one load balancer), else a
 * random per-process one (a reconnect to another instance, or after a restart, re-renders the
 * route for a fresh token, and another instance cannot open this one's snapshots).
 *
 * @returns The secret.
 * @throws {Error} When `DENEXT_LIVE_VIEW_SECRET` is set to fewer than 16 characters.
 */
export function liveViewSecret(): string {
  let configured: string | undefined;
  try {
    configured = (globalThis as { Deno?: typeof Deno }).Deno?.env.get(LIVE_VIEW_SECRET_ENV);
  } catch { /* no env permission: the per-process key */ }
  if (configured) {
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `denext: ${LIVE_VIEW_SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters; ` +
          "generate one with `openssl rand -base64 32`",
      );
    }
    return configured;
  }
  // One key per process, shared by every copy of this module (see process-shared.ts).
  return processShared("liveViewSecret", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  });
}

const keys = /* @__PURE__ */ new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys.set(secret, key);
  }
  return key;
}

function tokenInput(view: string, props: string, iat: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${TOKEN_DOMAIN}\0${view}\0${props}\0${iat}`);
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Sign a view's props (the JSON text the page carries). The token is
 * `<issued-at, base-36 seconds>.<HMAC>`: the MAC covers the view, the props and the issue time.
 *
 * @param view The view id.
 * @param props The props as JSON text.
 * @param now The signing time in ms (tests).
 * @returns The token.
 */
export async function signLiveViewToken(
  view: string,
  props: string,
  now: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000).toString(36);
  const key = await hmacKey(liveViewSecret());
  const sig = await crypto.subtle.sign("HMAC", key, tokenInput(view, props, iat));
  return `${iat}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Check a token against a view's props (constant time), and that it is younger than `maxAgeSeconds`.
 *
 * @param view The view id.
 * @param props The props as JSON text.
 * @param token The token the client sent.
 * @param maxAgeSeconds How long after signing it is accepted (`live.limits.viewTokenMaxAgeSeconds`).
 * @returns Whether the server signed exactly these props for this view, recently enough.
 */
export async function verifyLiveViewToken(
  view: string,
  props: string,
  token: string,
  maxAgeSeconds: number = DEFAULT_VIEW_TOKEN_MAX_AGE_SECONDS,
): Promise<boolean> {
  if (typeof token !== "string" || token.length > 128) return false;
  const dot = token.indexOf(".");
  const iat = token.slice(0, dot);
  if (dot < 1 || !/^[0-9a-z]{1,10}$/.test(iat)) return false;
  const sig = fromBase64Url(token.slice(dot + 1));
  if (!sig) return false;
  const age = Math.floor(Date.now() / 1000) - parseInt(iat, 36);
  if (age > maxAgeSeconds || age < -TOKEN_CLOCK_SKEW_SECONDS) return false;
  const key = await hmacKey(liveViewSecret());
  return crypto.subtle.verify("HMAC", key, sig, tokenInput(view, props, iat));
}

/** Views already warned about having no `authorize` (once each per process). */
const warnedNoAuthorize = /* @__PURE__ */ processShared(
  "liveViewNoAuthorize",
  () => new Set<string>(),
);

/**
 * Under `denext dev`, warn once that view `id` has no `authorize`: whoever holds the page's signed
 * props may mount it. A warning, not an error: `authorize` stays optional for public views.
 */
function warnNoAuthorize(id: string): void {
  if ((globalThis as { __denextDev?: boolean }).__denextDev !== true) return;
  if (warnedNoAuthorize.has(id)) return;
  warnedNoAuthorize.add(id);
  console.warn(
    `denext live view ${id}: no \`authorize\` — any viewer holding the page's signed props may ` +
      "mount it until they expire (`live.limits.viewTokenMaxAgeSeconds`). Add " +
      "`authorize: (props) => …` (it runs in the viewer's session) unless the view is public.",
  );
}

/** The props a component receives besides `init`'s (stripped before `init` sees them). */
function initProps(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const { children: _c, key: _k, ref: _r, ...rest } = props ?? {};
  return rest;
}

/**
 * Define a server-held live view: a Model–View–Update program whose model lives on the server,
 * one instance per Live connection. Render the returned component from a Server Component; the
 * first paint is plain HTML (no JavaScript needed), and in the browser the view mounts over the
 * Live socket — events bound with `send(…)` run `update` on the server and come back as DOM
 * patches.
 *
 * @param config The program (`init` / `update` / `view` / `subscriptions`), its `id`, an optional
 *   `authorize` and an optional `events` payload schema.
 * @returns A Server Component taking the props `init` receives.
 * @example
 * ```tsx
 * export const Counter = defineLiveView({
 *   id: "counter",
 *   init: (props: { start: number }) => [{ n: props.start }],
 *   update: (_msg: { type: "inc" }, m) => [{ n: m.n + 1 }],
 *   view: (m, send) => <button type="button" onClick={send({ type: "inc" })}>{m.n}</button>,
 * });
 * ```
 */
export function defineLiveView<Model, Msg, Props = Record<string, never>>(
  config: LiveViewConfig<Model, Msg, Props>,
): LiveViewComponent<Props> {
  if (typeof config.id !== "string" || config.id.length === 0 || config.id.length > 128) {
    throw new TypeError("defineLiveView: `id` must be a non-empty string of at most 128 chars");
  }
  views.set(config.id, config as unknown as LiveViewDef);
  const component = async (raw: Props): Promise<VNode | null> => {
    const props = initProps(raw as Record<string, unknown>) as Props;
    if (!config.authorize) warnNoAuthorize(config.id);
    else if (!(await config.authorize(props, { connection: null }))) return null;
    const [model] = config.init(props);
    const { send } = createHandlerTable<Msg>();
    const prepared = prepareWire(props);
    const json = JSON.stringify(prepared.value ?? {});
    const token = await signLiveViewToken(config.id, json);
    return h(
      LiveViewIsland,
      {
        view: config.id,
        props: json,
        token,
        ...(prepared.tagged ? { enc: WIRE_ENC } : {}),
      },
      config.view(model, send) as VNodeChildren,
    );
  };
  Object.defineProperty(component, "denextLiveViewId", { value: config.id });
  return component as LiveViewComponent<Props>;
}
