/**
 * The app's will-navigate hook: `runDesktop({ onWillNavigate })`, `onWillNavigate(fn)` on its
 * result and an extension's `host.onWillNavigate(fn)` see every top-level navigation of every
 * window before the runtime's navigation guard (`desktop.app.origin`,
 * `desktop.app.allowedNavigationOrigins`) applies, and may refuse it (`preventDefault()`) or let
 * it load in the window although the guard would send it to the browser (`allow()`).
 *
 * The runtime contract: a Deno Desktop runtime with the hook publishes
 * `Deno.desktop.navigationEvents === true` ({@linkcode runtimeHasNavigationEvents}) and dispatches
 * a cancelable `"willnavigate"` event on the `Deno.BrowserWindow` whose top-level frame is about to
 * navigate, synchronously, before its guard decides, with `detail: { url, initiator?, kind,
 * allow() }` (`kind`: `"link"`, `"script"`, `"redirect"`, `"window-open"` or `"other"`).
 * `preventDefault()` refuses the navigation (nothing loads, nothing opens in the browser);
 * `detail.allow()` loads it in place. With no listener the guard decides alone, so a window is
 * listened to only while a hook is subscribed. Handlers run in order and synchronously (a promise
 * one returns is not waited for); a refusal wins over an allowance, and a handler that throws is
 * logged and decides nothing. On a runtime without the event the hooks are never called.
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

/** How a top-level navigation started. */
export type DesktopNavigationKind = "link" | "script" | "redirect" | "window-open" | "other";

/** A top-level navigation about to happen ({@linkcode DesktopWillNavigateHandler}). */
export interface DesktopWillNavigateEvent {
  /** Where the window is going. */
  readonly url: string;
  /** The window's id (`"main"`, `"panel"` or the id `windows.open` returned). */
  readonly window: string;
  /** How it started. */
  readonly kind: DesktopNavigationKind;
  /** The URL of the document that started it, when the engine says. */
  readonly initiator?: string;
  /** Refuse it: nothing loads and nothing opens in the browser. Wins over {@linkcode allow}. */
  preventDefault(): void;
  /** Load it in the window, even where the navigation guard would send it to the browser. */
  allow(): void;
  /** Whether a handler refused it. */
  readonly defaultPrevented: boolean;
}

/** A will-navigate hook: decide synchronously (a returned promise is not waited for). */
export type DesktopWillNavigateHandler = (event: DesktopWillNavigateEvent) => void;

/** The runtime's `"willnavigate"` event, as far as it is read. */
interface RuntimeNavigationEvent extends Event {
  readonly detail?: {
    readonly url?: unknown;
    readonly initiator?: unknown;
    readonly kind?: unknown;
    readonly allow?: unknown;
  };
}

const KINDS: readonly DesktopNavigationKind[] = ["link", "script", "redirect", "window-open"];

/** The runtime event name. */
const EVENT = "willnavigate";

/**
 * Whether the running runtime dispatches `"willnavigate"` on its windows: `Deno.desktop
 * .navigationEvents === true`. Feature-detected; the stock runtime, a denext runtime without the
 * hook and the Deno CLI answer `false`.
 *
 * @param desktop `Deno.desktop` (default: the running runtime's).
 * @returns Whether the hook can fire.
 */
export function runtimeHasNavigationEvents(
  desktop: unknown = (Deno as unknown as { desktop?: unknown }).desktop,
): boolean {
  try {
    return (desktop as { navigationEvents?: unknown } | null | undefined)?.navigationEvents ===
      true;
  } catch {
    return false;
  }
}

/** Options for {@linkcode createWillNavigateHooks}. */
export interface WillNavigateOptions {
  /** Whether the runtime has the event (default: {@linkcode runtimeHasNavigationEvents}). */
  readonly supported?: boolean;
  /**
   * Follow the app's windows: call `attach` for each open window and each one that opens, and
   * return the unsubscribe. Without it no window is listened to.
   */
  readonly watchWindows?: (attach: (id: string, window: EventTarget) => void) => () => void;
  /** Log a handler's failure (default `console.error`). */
  readonly log?: (message: string, err: unknown) => void;
}

/** The hooks: subscribe, and run them for one runtime event (exported for tests). */
export interface WillNavigateHooks {
  /** Subscribe `fn`; returns its unsubscribe. On a runtime without the event it is never called. */
  add(fn: DesktopWillNavigateHandler): () => void;
  /** Whether the runtime has the event. */
  readonly supported: boolean;
  /** How many windows are listened to now (tests). */
  listening(): number;
}

/** Our event over the runtime's, recording the handlers' decisions. */
function wrapEvent(windowId: string, e: RuntimeNavigationEvent) {
  const d = e.detail ?? {};
  const state = { prevented: false, allowed: false };
  const kind = KINDS.includes(d.kind as DesktopNavigationKind)
    ? d.kind as DesktopNavigationKind
    : "other";
  const event: DesktopWillNavigateEvent = Object.freeze({
    url: typeof d.url === "string" ? d.url : "",
    window: windowId,
    kind,
    ...(typeof d.initiator === "string" ? { initiator: d.initiator } : {}),
    preventDefault: () => {
      state.prevented = true;
    },
    allow: () => {
      state.allowed = true;
    },
    get defaultPrevented() {
      return state.prevented;
    },
  });
  return { event, state };
}

/**
 * Create the app's will-navigate hooks. A window is listened to only while at least one hook is
 * subscribed.
 *
 * @param options The runtime support and how to follow the windows.
 * @returns The hooks.
 */
export function createWillNavigateHooks(options: WillNavigateOptions = {}): WillNavigateHooks {
  const supported = options.supported ?? runtimeHasNavigationEvents();
  const log = options.log ?? ((message, err) => console.error(message, err));
  const handlers = new Set<DesktopWillNavigateHandler>();
  const attached = new Map<string, { window: EventTarget; listener: (e: Event) => void }>();
  let unwatch: (() => void) | undefined;

  const dispatch = (windowId: string, e: RuntimeNavigationEvent) => {
    const { event, state } = wrapEvent(windowId, e);
    for (const fn of [...handlers]) {
      try {
        fn(event);
      } catch (err) {
        log("desktop: an onWillNavigate hook failed", err);
      }
    }
    if (state.prevented) e.preventDefault();
    else if (state.allowed && typeof e.detail?.allow === "function") e.detail.allow();
  };

  const attach = (id: string, window: EventTarget) => {
    if (attached.has(id) || typeof window?.addEventListener !== "function") return;
    const listener = (e: Event) => dispatch(id, e as RuntimeNavigationEvent);
    window.addEventListener(EVENT, listener);
    attached.set(id, { window, listener });
  };

  const stop = () => {
    unwatch?.();
    unwatch = undefined;
    for (const { window, listener } of attached.values()) {
      window.removeEventListener(EVENT, listener);
    }
    attached.clear();
  };

  return {
    supported,
    listening: () => attached.size,
    add: (fn) => {
      handlers.add(fn);
      if (supported && unwatch === undefined && options.watchWindows) {
        unwatch = options.watchWindows(attach);
      }
      return () => {
        handlers.delete(fn);
        if (handlers.size === 0) stop();
      };
    },
  };
}
