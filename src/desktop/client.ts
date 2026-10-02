/**
 * The page side of Deno Desktop extensions (`denext/desktop/client`): a typed proxy for a
 * user extension's methods ({@linkcode desktopExtension}) and a subscription to the runtime's
 * event stream ({@linkcode onDesktopEvent}).
 *
 * An extension is TypeScript that runs in the desktop app's Deno process
 * (`defineDesktopExtension` from `denext/desktop`) and is enabled in
 * `desktop.capabilities.extensions`. The page reaches it only through the runtime's gated
 * bridge: a per-launch token, the exact window origin and a JSON content type, then the
 * capability allowlist and the method's input schema.
 *
 * This module is client-safe: web APIs only, no Deno APIs, nothing runs at import. Off desktop
 * (the web, iOS, Android, SSR) a call rejects `unavailable` without making a request, and a
 * subscription does nothing.
 *
 * @example
 * ```ts
 * import { desktopExtension, isDesktopBridgeError, onDesktopEvent } from "denext/desktop/client";
 * import type scanner from "./desktop/extensions/scanner.ts";
 *
 * const scan = desktopExtension<typeof scanner>("scanner");
 * try {
 *   const devices = await scan.listDevices({}); // typed from the extension's schemas
 * } catch (err) {
 *   if (isDesktopBridgeError(err) && err.code === "unavailable") showWebFallback();
 * }
 * const stop = onDesktopEvent<{ id: string }>("scanner", "attached", ({ id }) => refresh(id));
 * ```
 *
 * @module
 */

import {
  desktopError,
  desktopRpc,
  type DesktopRpcOptions,
  subscribeDesktopEvent,
} from "./bridge-client.ts";

export {
  type DesktopBridgeError,
  type DesktopErrorCode,
  type DesktopRpcOptions,
  isDesktopBridgeError,
} from "./bridge-client.ts";

/**
 * The slice of a Standard Schema (https://standardschema.dev) the extension typing reads: its
 * `input` and `output` types.
 */
export interface DesktopSchemaTypes<In = unknown, Out = In> {
  /** The Standard Schema v1 marker. */
  readonly "~standard": {
    /** The schema's static types. */
    readonly types?: { readonly input: In; readonly output: Out };
  };
}

/** One extension method as the typing reads it: an input schema, an output schema, a handler. */
export interface DesktopMethodShape {
  /** Validates the page's arguments. */
  readonly input?: unknown;
  /** Strips the handler's result before it reaches the page. */
  readonly output?: unknown;
  /** Runs in the Deno process. */
  readonly handler?: (...args: never[]) => unknown;
}

/** An extension (or the module that default-exports it) as the typing reads it. */
export type DesktopExtensionModule =
  | { readonly methods: Readonly<Record<string, DesktopMethodShape>> }
  | { readonly default: { readonly methods: Readonly<Record<string, DesktopMethodShape>> } };

/** The extension itself: the module's default export, or the value given. */
export type DesktopExtensionOf<M> = M extends { readonly default: infer D } ? D : M;

/** What the page passes to a method: its input schema's input type, else the handler's argument. */
export type DesktopMethodInput<Mth> = Mth extends
  { readonly input: DesktopSchemaTypes<infer I, unknown> } ? I
  : Mth extends { readonly handler: (args: infer A, ...rest: never[]) => unknown } ? A
  : unknown;

/** What a method resolves on the page: its output schema's output type, else the handler's result. */
export type DesktopMethodOutput<Mth> = Mth extends
  { readonly output: DesktopSchemaTypes<unknown, infer O> } ? O
  : Mth extends { readonly handler: (...args: never[]) => infer R } ? Awaited<R>
  : unknown;

/** The typed proxy {@linkcode desktopExtension} returns: one async function per method. */
export type DesktopExtensionClient<M> = DesktopExtensionOf<M> extends { readonly methods: infer Ms }
  ? {
    readonly [K in keyof Ms & string]: (
      args: DesktopMethodInput<Ms[K]>,
      options?: DesktopRpcOptions,
    ) => Promise<DesktopMethodOutput<Ms[K]>>;
  }
  : Readonly<Record<string, (args?: unknown, options?: DesktopRpcOptions) => Promise<unknown>>>;

/**
 * A typed client for the desktop extension `name`. Each property is an async function that
 * calls that method in the Deno process through the bridge.
 *
 * Pass the extension's type (`typeof import("./desktop/extensions/scanner.ts")`, or the
 * default export's `typeof`) to type the arguments and results from its schemas; without it,
 * every method takes and returns `unknown`.
 *
 * @param name The extension's `name` (as given to `defineDesktopExtension` and listed in
 * `desktop.capabilities.extensions`).
 * @returns The proxy. A call rejects with a {@linkcode DesktopBridgeError}: `unavailable` off
 * desktop (no request is made) or when the extension is not enabled, `validation` when the
 * arguments do not match the input schema, `timeout` after 30 s (pass `{ timeoutMs }`), or the
 * extension's own code.
 * @example
 * ```ts
 * import { desktopExtension } from "denext/desktop/client";
 *
 * const scanner = desktopExtension<typeof import("./desktop/extensions/scanner.ts")>("scanner");
 * const devices = await scanner.listDevices({});
 * ```
 */
export function desktopExtension<M = DesktopExtensionModule>(
  name: string,
): DesktopExtensionClient<M> {
  if (typeof name !== "string" || name === "") {
    throw new TypeError("desktopExtension: the name must be a non-empty string");
  }
  const methods = new Map<
    string,
    (args?: unknown, options?: DesktopRpcOptions) => Promise<unknown>
  >();
  return new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      // Not a thenable, not a symbol-keyed protocol: only string method names call through.
      if (typeof prop !== "string" || prop === "then") return undefined;
      let call = methods.get(prop);
      if (!call) {
        call = (args?: unknown, options?: DesktopRpcOptions) =>
          desktopRpc(name, prop, args, options);
        methods.set(prop, call);
      }
      return call;
    },
    has: () => false,
    ownKeys: () => [],
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  }) as DesktopExtensionClient<M>;
}

/**
 * Call `handler` for each `event` the desktop runtime emits for `cap`: an extension's name (its
 * handlers emit the events it declares with `ctx.emit`), or a built-in capability that emits
 * events (today only the `echo` diagnostic's `pong`). The first
 * subscription opens the event stream and the last unsubscribe closes it; frames that arrived
 * before a handler for that event subscribed are delivered to it once it does. Off desktop it
 * does nothing.
 *
 * @param cap The capability or extension name.
 * @param event The event name the capability declares.
 * @param handler Called with each event's data.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onDesktopEvent } from "denext/desktop/client";
 *
 * const stop = onDesktopEvent<{ id: string }>("scanner", "attached", ({ id }) => {
 *   console.log("scanner attached", id);
 * });
 * ```
 */
export function onDesktopEvent<T = unknown>(
  cap: string,
  event: string,
  handler: (data: T) => void,
): () => void {
  return subscribeDesktopEvent(cap, event, handler as (data: unknown) => void);
}

/** Who handles one of the app's deep-link schemes ({@linkcode deepLinkSchemeOwner}). */
export interface DeepLinkSchemeOwner {
  /** `self` (this app), `other` (another app gets links with the scheme), `none` (no app). */
  readonly owner: "self" | "other" | "none";
  /**
   * What the OS names as the handler (a bundle id, an executable path, a `.desktop` id), for
   * display only: any program of the user can write it.
   */
  readonly handler?: string;
}

/** What {@linkcode claimDeepLinkScheme} reports. */
export interface ClaimDeepLinkSchemeResult extends DeepLinkSchemeOwner {
  /** Whether this app handles the scheme now. */
  readonly registered: boolean;
  /** Why not, when it doesn't (a Windows "UserChoice", no `xdg-mime`, an unpackaged run, …). */
  readonly reason?: string;
}

/**
 * Which app handles `scheme`, one of the app's `desktop.app.deepLinks` (denext's pinned Deno
 * Desktop runtime). A snapshot, and advisory: any program of the same user can register itself for
 * a scheme at any time, so keep PKCE and `state` on every sign-in.
 *
 * @param scheme A scheme from `desktop.app.deepLinks` (`"myapp"`).
 * @returns The owner. Rejects `scheme_not_declared` for another scheme, `unsupported` on a runtime
 * without scheme registration, and `unavailable` off desktop.
 */
export async function deepLinkSchemeOwner(scheme: string): Promise<DeepLinkSchemeOwner> {
  return await desktopRpc<DeepLinkSchemeOwner>("deepLinks", "owner", { scheme });
}

/**
 * Make this app the handler of `scheme` (one of its `desktop.app.deepLinks`), taking it over from
 * another app. **Only on an explicit user action** — a "Make this app the handler of myapp: links"
 * button after `openAuthSession` rejected `scheme_owned_by_other_app` — because the other app loses
 * the scheme. On macOS the OS may confirm it with the user; a Windows "UserChoice" cannot be
 * overridden (`registered: false`). It must run inside that click: where the webview reports user
 * activation (`navigator.userActivation`) and there is none, it rejects `user_activation_required`
 * without calling the runtime. The runtime also takes a scheme over only from ANOTHER app (this
 * app's own or an unclaimed scheme is registered without force), and only once per scheme per
 * launch.
 *
 * @param scheme A scheme from `desktop.app.deepLinks`.
 * @returns The registration after the call.
 */
export async function claimDeepLinkScheme(scheme: string): Promise<ClaimDeepLinkSchemeResult> {
  const activation = (globalThis as { navigator?: { userActivation?: { isActive?: unknown } } })
    .navigator?.userActivation;
  if (activation !== undefined && activation.isActive !== true) {
    throw desktopError(
      "deepLinks",
      "claim",
      "user_activation_required",
      "call claimDeepLinkScheme from the user's click on your confirmation button",
    );
  }
  return await desktopRpc<ClaimDeepLinkSchemeResult>("deepLinks", "claim", { scheme });
}
