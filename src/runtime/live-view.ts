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
   * viewer holding the page's signed props may mount the view.
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

/** The MAC domain of a live view's props token. */
const TOKEN_DOMAIN = "denext.liveview.v1";

/**
 * The key live-view tokens are signed with, and the shared view store's snapshots are sealed
 * under: `DENEXT_LIVE_VIEW_SECRET` (shared by every instance behind one load balancer), else a
 * random per-process one (a reconnect to another instance, or after a restart, re-renders the
 * route for a fresh token, and another instance cannot open this one's snapshots).
 *
 * @returns The secret.
 */
export function liveViewSecret(): string {
  let configured: string | undefined;
  try {
    configured = (globalThis as { Deno?: typeof Deno }).Deno?.env.get("DENEXT_LIVE_VIEW_SECRET");
  } catch { /* no env permission: the per-process key */ }
  if (configured) return configured;
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

function tokenInput(view: string, props: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${TOKEN_DOMAIN}\0${view}\0${props}`);
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
 * Sign a view's props (the JSON text the page carries).
 *
 * @param view The view id.
 * @param props The props as JSON text.
 * @returns The token.
 */
export async function signLiveViewToken(view: string, props: string): Promise<string> {
  const key = await hmacKey(liveViewSecret());
  const sig = await crypto.subtle.sign("HMAC", key, tokenInput(view, props));
  return toBase64Url(new Uint8Array(sig));
}

/**
 * Check a token against a view's props (constant time).
 *
 * @param view The view id.
 * @param props The props as JSON text.
 * @param token The token the client sent.
 * @returns Whether the server signed exactly these props for this view.
 */
export async function verifyLiveViewToken(
  view: string,
  props: string,
  token: string,
): Promise<boolean> {
  const sig = typeof token === "string" && token.length <= 128 ? fromBase64Url(token) : null;
  if (!sig) return false;
  const key = await hmacKey(liveViewSecret());
  return crypto.subtle.verify("HMAC", key, sig, tokenInput(view, props));
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
    if (config.authorize && !(await config.authorize(props, { connection: null }))) return null;
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
