// `defineLustreView`: a Lustre app run on the server as a server component, one instance per
// mounted view per Live connection, its DOM patches carried over denext's Live socket (beside
// `defineLiveView`, which does the same for a TypeScript Model–View–Update program).
//
//   // app/counter-view.ts (a server module)
//   import { defineLustreView } from "denext/gleam";
//   import { lustreServer } from "../.denext/lustre-server.ts";
//   import * as counter from "@gleam/app/counter.mjs";
//   export const CounterView = defineLustreView({
//     id: "counter",
//     kit: lustreServer,
//     app: counter.app(),
//     flags: (props: { start: number }) => props.start,
//   });
//   // app/page.tsx: <CounterView start={1} />
//
// The component renders the app's first view as HTML (so the page works with JavaScript disabled)
// inside the app's Lustre view island, with the props and an HMAC over them. In the browser the
// island mounts the view over the Live socket: the server checks the token and `authorize`, starts
// the Lustre runtime with the flags, and streams Lustre's own messages (the whole view, then
// patches); DOM events go back as Lustre's `EventFired` messages, validated before Lustre's decoders
// see them. Lustre's model is an arbitrary Gleam value, so a view is never written to the shared
// view store: a reconnect to the same server instance within `live.limits.viewResumeSeconds`
// reattaches the running runtime, and any other reconnect runs `init` again.
//
// This module is isomorphic; the per-connection runtime is `src/server/lustre-views.ts`.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import type { StandardSchemaV1 } from "../runtime/define-action.ts";
import { type LiveViewContext, signLiveViewToken } from "../runtime/live-view.ts";
import { prepareWire, WIRE_ENC } from "../runtime/wire-codec.ts";
import type { LustreApp } from "./kit.ts";
import type { LustreServerKit } from "./server-kit.ts";
import { processShared } from "../runtime/process-shared.ts";

/** A DOM event a Lustre view's client sent, after the built-in shape check. */
export interface LustreEventPayload {
  /** The event's name (`click`, `input`, a custom event's name, …). */
  name: string;
  /** The event's data as the client picked it (`{ target: { value } }`, `{ key }`, …). */
  event: unknown;
}

/** What {@link defineLustreView} takes. */
export interface LustreViewConfig<Flags, Props> {
  /** A stable id, unique in the app (the browser mounts the view by it). */
  id: string;
  /** The app's Lustre server kit (`import { lustreServer } from "../.denext/lustre-server.ts"`). */
  kit: LustreServerKit;
  /** The Lustre app (`counter.app()`). */
  app: LustreApp<Flags>;
  /** The app's flags from the component's props. Default: the `flags` prop. */
  flags?: (props: Props) => Flags;
  /**
   * May this viewer see the view with these props? Runs in the viewer's session when the page
   * renders, when the browser mounts or resumes the view, and again every
   * `live.limits.channelAuthTtlSeconds` while it runs. `false` (or a throw) renders nothing on the
   * page and ends the view on the socket (`denied`).
   */
  authorize?: (props: Props, ctx: LiveViewContext) => boolean | Promise<boolean>;
  /**
   * Validates every DOM event the client sends (after the built-in shape check) before Lustre's
   * decoders see it. A rejected event is an `invalid-input` error and nothing is dispatched.
   */
  events?: StandardSchemaV1<LustreEventPayload>;
}

/** The component {@link defineLustreView} returns. */
export interface LustreViewComponent<Props> {
  /** Render the view with `props`. */
  (props: Props): Promise<VNode | null>;
  /** The view's id. */
  readonly denextLustreViewId: string;
}

/** What the hub needs from a registered view (the config, untyped). */
export type LustreViewDef = LustreViewConfig<unknown, unknown>;

/** Every Lustre view by id, shared by every copy of this module (see process-shared.ts). */
const views = /* @__PURE__ */ processShared("lustreViews", () => new Map<string, LustreViewDef>());

/**
 * The Lustre view registered under `id` (the hub mounts by it).
 *
 * @param id The view id.
 * @returns The definition, or `undefined` when no module defining it has loaded.
 */
export function getLustreView(id: string): LustreViewDef | undefined {
  return views.get(id);
}

/**
 * The name a Lustre view's props token is signed under: its own namespace, so a token minted for
 * one can never mount a `defineLiveView` of the same id, or the other way round.
 *
 * @param id The view id.
 * @returns The signing name.
 */
export function lustreTokenName(id: string): string {
  return `lustre\u0000${id}`;
}

/** The props a component receives besides the flags' source (stripped before `flags` sees them). */
function ownProps(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const { children: _c, key: _k, ref: _r, ...rest } = props ?? {};
  return rest;
}

/**
 * The app's flags for `props`.
 *
 * @param def The view.
 * @param props The component's props.
 * @returns What `init` receives.
 */
export function lustreViewFlags(def: LustreViewDef, props: unknown): unknown {
  return def.flags ? def.flags(props) : (props as { flags?: unknown } | null)?.flags;
}

/**
 * Define a Lustre server component: a Lustre app whose state lives on the server, one runtime per
 * mounted view per Live connection. Render the returned component from a Server Component.
 *
 * @param config The view's id, the app's Lustre server kit, the app, how props become flags, and
 *   its gates (`authorize`, an `events` schema).
 * @returns A Server Component taking the props the flags come from.
 * @example
 * ```ts
 * import { defineLustreView } from "denext/gleam";
 * import { lustreServer } from "../.denext/lustre-server.ts";
 * import * as counter from "@gleam/app/counter.mjs";
 *
 * export const CounterView = defineLustreView({
 *   id: "counter",
 *   kit: lustreServer,
 *   app: counter.app(),
 *   flags: (props: { start: number }) => props.start,
 * });
 * ```
 */
export function defineLustreView<Flags, Props = { flags: Flags }>(
  config: LustreViewConfig<Flags, Props>,
): LustreViewComponent<Props> {
  if (typeof config.id !== "string" || config.id.length === 0 || config.id.length > 128) {
    throw new TypeError("defineLustreView: `id` must be a non-empty string of at most 128 chars");
  }
  const def = config as unknown as LustreViewDef;
  views.set(config.id, def);
  const component = async (raw: Props): Promise<VNode | null> => {
    const props = ownProps(raw as Record<string, unknown>) as Props;
    if (config.authorize && !(await config.authorize(props, { connection: null }))) return null;
    const html = config.kit.render(config.app, lustreViewFlags(def, props) as Flags);
    const prepared = prepareWire(props);
    const json = JSON.stringify(prepared.value ?? {});
    const token = await signLiveViewToken(lustreTokenName(config.id), json);
    return h(config.kit.island, {
      view: config.id,
      props: json,
      token,
      html,
      ...(prepared.tagged ? { enc: WIRE_ENC } : {}),
    });
  };
  Object.defineProperty(component, "denextLustreViewId", { value: config.id });
  return component as LustreViewComponent<Props>;
}
