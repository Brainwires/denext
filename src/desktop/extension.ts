/**
 * Deno Desktop native extensions, authoring side (`denext/desktop`): the types and the
 * {@linkcode defineDesktopExtension} helper for a capability that runs in the desktop app's Deno
 * process. A capability is plain TypeScript there — it uses Deno/Node APIs, an existing `Deno.*`
 * desktop API, a CLI tool, FFI, or a sidecar — and the page reaches it only through the runtime's
 * gated bridge (see {@link ./bridge.ts}): a per-launch token, the exact window origin, a JSON
 * content type, then the capability allowlist and the method's input schema.
 *
 * This module is RUNTIME-ONLY (it is imported by the desktop entry via `runDesktop`, never by a
 * client bundle — the same convention as {@link ./auth-session-runtime.ts} and {@link ./updater.ts}).
 * The page-side counterpart is `denext/desktop/client` ({@link ./client.ts}).
 *
 * @module
 */

import type { DesktopWillNavigateHandler } from "./will-navigate.ts";
import type { StandardResult, StandardSchemaV1 } from "../runtime/define-action.ts";
import type {
  DesktopOpenWindowOptions,
  DesktopSecondInstanceEvent,
  DesktopWindowRef,
} from "./app-windows.ts";
import type { DesktopWindowMenuItemHandler } from "./window-menu.ts";

export type { StandardSchemaV1 };

/**
 * The Deno permissions a capability method needs, as `--allow-*` scopes. The union of every
 * enabled capability's descriptor is what the package scripts bake into the desktop binary
 * instead of `-A` (least-privilege packaging), and what `denext doctor` reports. An `ffi` or
 * `run` entry means full-trust native code: least-privilege is moot for that surface once it is on.
 */
export interface DesktopPermissions {
  /** `--allow-read` paths (a bundle-relative or absolute path, or a token like `$APPDATA`). */
  readonly read?: readonly string[];
  /** `--allow-write` paths. */
  readonly write?: readonly string[];
  /** `--allow-net` hosts. */
  readonly net?: readonly string[];
  /** `--allow-run` programs (a sidecar or CLI tool). Full trust. */
  readonly run?: readonly string[];
  /** `--allow-ffi` libraries. Full trust. */
  readonly ffi?: readonly string[];
  /** `--allow-env` variable names. */
  readonly env?: readonly string[];
  /** `--allow-sys` kinds. */
  readonly sys?: readonly string[];
}

/**
 * The context a capability handler runs with: a scoped {@linkcode DesktopCapCtx.emit} for its
 * declared events, the OS app-support directory (which survives relaunch, unlike browser storage —
 * see the desktop storage note), the running OS, the app window (Deno's `BrowserWindow` when the
 * runtime exposes it), and an {@linkcode AbortSignal} that fires when the handler's timeout elapses.
 */
export interface DesktopCapCtx {
  /**
   * Push an event to the pages' event stream: every window's, or only `options.window`'s. `event`
   * must be one the capability declared in {@linkcode DesktopCapability.events}; emitting an
   * undeclared event throws. Events are retained for replay, so a page that subscribes later still
   * receives it. For work that outlives the call (or that no page call started), use the
   * {@linkcode DesktopExtensionHost} {@linkcode DesktopCapability.setup} receives.
   */
  emit(event: string, data: unknown, options?: DesktopEmitOptions): void;
  /**
   * The absolute host path of a file or folder the USER picked in this launch: a `handle` that a
   * native dialog (`pickDocument`, `openFile`, `saveFile`, `pickFolder`), a file dropped on a window
   * or a file the OS opened with the app produced. Use it to hand a picked file to a host program
   * (a CLI tool) that needs its path. Anything else — a path string, a forged or expired handle —
   * throws a `forbidden` {@linkcode DesktopCapError}, so page script cannot turn a string of its
   * choosing into a host path. With `{ write: true }` a read-only handle (an opened or dropped
   * file) is refused too. Never send the returned path back to the page.
   */
  pickedPath(handle: unknown, options?: DesktopPickedPathOptions): string;
  /** The OS per-app support directory (create-on-first-use); durable across launches. */
  readonly appSupportDir: string;
  /** The running OS. */
  readonly os: "darwin" | "windows" | "linux";
  /**
   * The app's `Deno.BrowserWindow` when the runtime exposes one (menu/tray/context-menu/navigate
   * capabilities use it), else `undefined`. Typed loosely because it is a Deno Desktop API not in
   * the ambient lib; a window capability narrows it.
   */
  readonly window?: unknown;
  /**
   * Which of the app's windows the call came from: `"main"` (the window the app started with, and
   * any page that cannot say), `"panel"` (the tray panel) or the id `openWindow` returned.
   * {@linkcode DesktopCapCtx.window} is that window. The bridge always sets it; absent (a context
   * built by hand, in a test) means `"main"`.
   */
  readonly windowId?: string;
  /**
   * Who called: the window's origin, the calling frame (main or sub, with its own origin) and the
   * window id, so a privileged handler can check the sender as well as the gate does. The bridge
   * always sets it; absent (a context built by hand, in a test) means nothing is known. See
   * {@linkcode DesktopCaller}.
   */
  readonly caller?: DesktopCaller;
  /**
   * Aborts when the handler exceeds its timeout, so a long native call can cooperate. For a
   * method with `timeoutMs: false` it also aborts when the calling page's request goes away (that
   * page reloaded, navigated or closed).
   */
  readonly signal: AbortSignal;
  /**
   * Call a native function on the app's UI thread (the thread AppKit, Win32 windows and GTK objects
   * belong to) and resolve with its pointer-sized return value as an unsigned `bigint`
   * (meaningless for a `void` function). `fn` is a C function `void* fn(void* context)`: a
   * `Deno.UnsafeFnPointer`, a `Deno.UnsafeCallback`, or a pointer (from `Deno.dlopen(...)` through
   * `Deno.UnsafePointer.of`); it is called with `context` (default `null`). The call is queued
   * behind the UI work already posted and never runs on the calling thread.
   *
   * **Full trust**: this is FFI. The app needs `--allow-ffi` (grant it in
   * `desktop.extraPermissions`), and a wrong pointer or signature crashes the app. A
   * `Deno.UnsafeCallback` runs on the JavaScript thread while the UI thread waits for it, so it must
   * not wait for the UI thread itself.
   *
   * Over `Deno.desktop.runOnMainThread`, so it needs denext's pinned Deno Desktop runtime
   * (2.9.7-denext.6 or later): elsewhere it rejects with a {@linkcode DesktopCapError} whose code is
   * `unsupported`. It also rejects, without calling `fn`, once the app is quitting.
   *
   * @param fn The native function to call on the UI thread.
   * @param context The pointer passed to `fn` (default `null`).
   * @returns `fn`'s return value as an unsigned `bigint`.
   */
  runOnMainThread(fn: DesktopMainThreadFn, context?: Deno.PointerValue): Promise<bigint>;
  /**
   * This capability's own secrets in the OS credential store (see {@linkcode DesktopSecureStore}),
   * apart from the pages' `secureStore` and from every other extension's.
   */
  readonly secureStore: DesktopSecureStore;
}

/**
 * The sender of a bridge call ({@linkcode DesktopCapCtx.caller}).
 *
 * The bridge answers only the app's own pages (the per-launch token, and under denext's pinned
 * runtime the memory transport with an `Origin` equal to the app origin), so `origin` is that
 * origin. `frame.kind` says whether the main frame or a subframe (a same-origin `<iframe>`) made
 * the call: told by the runtime when it marks frames (`frame.verified: true`, on a Deno Desktop
 * runtime that publishes `Deno.desktop.marksFrames`, under CEF or WKWebView; WebView2 and
 * WebKitGTK don't say which frame called), else as the calling page reported it (`verified: false`: a subframe
 * that holds the token can claim to be the main frame), and `"unknown"` when neither said.
 */
export interface DesktopCaller {
  /** The origin of the calling window's page (the app origin, or the loopback origin). */
  readonly origin: string;
  /** The frame that made the call. */
  readonly frame: DesktopCallerFrame;
  /** The calling window's id ({@linkcode DesktopCapCtx.windowId}). */
  readonly window: string;
}

/** The frame a bridge call came from ({@linkcode DesktopCaller.frame}). */
export interface DesktopCallerFrame {
  /** `"main"` (the top-level page), `"sub"` (a frame inside it) or `"unknown"`. */
  readonly kind: "main" | "sub" | "unknown";
  /** The frame's own origin (the request's `Origin`, else the window's origin). */
  readonly origin: string;
  /** Whether the runtime told `kind`, rather than the calling page. */
  readonly verified: boolean;
}

/**
 * An extension's own secrets in the OS credential store: the store the pages reach as
 * `secureStore` (the runtime's Keychain store on macOS, the Secret Service on Linux, the
 * PasswordVault on Windows), under a namespace of the extension's own: `<app identifier>/ext/<name>`,
 * `<name>` being the capability's name. A page can never read or write it, nor can another
 * extension; the extension cannot reach the pages' items either. Keys and values are the page
 * API's: a key must not start with `-` or hold a control character (a `validation`
 * {@linkcode DesktopCapError}), a value is any string.
 *
 * It needs the `secureStore` capability enabled (`denext desktop add secure-store`): otherwise
 * every call rejects with a {@linkcode DesktopCapError} (code `not_enabled`) saying so. The store's
 * own failures are the page API's codes (`backend_unavailable`, `store_failed`).
 */
export interface DesktopSecureStore {
  /** The value stored for `key`, or `null` for none. */
  get(key: string): Promise<string | null>;
  /** Store `value` for `key` (replacing any value). */
  set(key: string, value: string): Promise<void>;
  /** Remove `key` (a no-op when it is absent). */
  delete(key: string): Promise<void>;
}

/** Where an event goes: {@linkcode DesktopCapCtx.emit}, {@linkcode DesktopExtensionHost.emit}. */
export interface DesktopEmitOptions {
  /**
   * The one window the event is for (`"main"`, `"panel"`, or an id `openWindow` returned); every
   * window's stream when omitted.
   */
  readonly window?: string;
}

/** Options for {@linkcode DesktopCapCtx.pickedPath}. */
export interface DesktopPickedPathOptions {
  /** The caller will write to the path: a read-only handle (an opened or dropped file) is refused. */
  readonly write?: boolean;
}

/**
 * One of the app's windows, as the lifecycle hooks report it ({@linkcode DesktopCapability.onWindowOpened},
 * {@linkcode DesktopExtensionHost.windows}).
 */
export interface DesktopWindowInfo {
  /** Its id: `"main"`, `"panel"` (the tray panel) or the id `openWindow` / `windows.open` returned. */
  readonly id: string;
  /** What it is. */
  readonly kind: "main" | "panel" | "window";
  /** The app-chosen key it was opened with (`windows.open({ key })`), if any. */
  readonly key?: string;
}

/**
 * A window that closed for good ({@linkcode DesktopCapability.onWindowClosed}): never a reload or a
 * navigation. `appQuitting` is `true` when the close is part of the app's quit — Cmd+Q, `quitApp()`,
 * the OS's session end, or the last app window closing without `desktop.app.keepAlive` — so a
 * resource shared by every window can be let go with the last one.
 */
export type DesktopWindowClosedInfo = DesktopWindowInfo & { readonly appQuitting: boolean };

/**
 * The options of {@linkcode DesktopExtensionHost.confirm}: the OS's own message box with your
 * button labels.
 */
export interface DesktopConfirmOptions {
  /** The main line (required). */
  readonly message: string;
  /** Smaller text under it. */
  readonly detail?: string;
  /** The window title where the OS shows one (macOS alerts have none). */
  readonly title?: string;
  /** The labels, at most 16 (none: one "OK"). Each OS places them its own way (macOS: first rightmost). */
  readonly buttons?: readonly string[];
  /** The button Return presses (default: the first). */
  readonly defaultId?: number;
  /** The button Escape presses (and the close button on Windows and Linux). */
  readonly cancelId?: number;
  /** The icon (default `"info"`). */
  readonly kind?: "info" | "warning" | "error";
}

/**
 * What an extension's {@linkcode DesktopCapability.setup} receives once, when the app starts: the
 * process-level counterpart of {@linkcode DesktopCapCtx}, for work the extension (or `desktop.ts`)
 * starts on its own — a tray-started job, a file watcher — that streams to the page with no page
 * call in flight. Keep it at module scope and use it for the life of the app.
 *
 * The window lifecycle is here too: `onWindowOpened` / `onWindowClosed` / `onAppQuit` subscribe
 * to what the static {@linkcode DesktopCapability.onWindowOpened} hooks receive, `onBeforeQuit`
 * can refuse a quit, `quit()` quits again, `onWindowMenuItem` takes the app's own Window-menu
 * items, `onSecondInstance` hears the app launched again, `onWillNavigate` sees (and may refuse)
 * every top-level navigation, and `windows()` lists the open windows now. Each subscription returns its unsubscribe.
 */
export interface DesktopExtensionHost {
  /**
   * Push an event to the pages' streams (every window's, or `options.window`'s). `event` must be
   * one the capability declared in {@linkcode DesktopCapability.events}; an undeclared one throws.
   * Events are retained for replay: one emitted before any page subscribes is delivered to the
   * first `onDesktopEvent` subscriber, as with {@linkcode DesktopCapCtx.emit}.
   */
  emit(event: string, data: unknown, options?: DesktopEmitOptions): void;
  /** The same lookup as {@linkcode DesktopCapCtx.pickedPath}. */
  pickedPath(handle: unknown, options?: DesktopPickedPathOptions): string;
  /** The OS per-app support directory (create-on-first-use); durable across launches. */
  readonly appSupportDir: string;
  /** The running OS. */
  readonly os: "darwin" | "windows" | "linux";
  /**
   * Call `fn` for every window that opens from now on — and first for each window open now, so a
   * subscriber that starts late still sees every window. An error it throws (or rejects with) is
   * logged, never surfaced. Returns the unsubscribe.
   */
  onWindowOpened(fn: (info: DesktopWindowInfo) => void | Promise<void>): () => void;
  /**
   * Call `fn` once a window closed for good (never on a reload or a navigation), with
   * {@linkcode DesktopWindowClosedInfo.appQuitting} saying whether the close is part of the app's
   * quit. A promise it returns is waited for, bounded, when the app is quitting; an error is logged,
   * never surfaced, and never keeps a window open. Returns the unsubscribe.
   */
  onWindowClosed(fn: (info: DesktopWindowClosedInfo) => void | Promise<void>): () => void;
  /**
   * Call `fn` once the app is about to quit, after every window's `onWindowClosed`, and wait for
   * it: at most 3 seconds for every `onAppQuit` hook together, after which the process exits
   * regardless. An error is logged, never surfaced. Returns the unsubscribe.
   */
  onAppQuit(fn: () => void | Promise<void>): () => void;
  /**
   * Ask `fn` before the app quits (`quitApp()`, `Deno.desktop.quit()`, Cmd+Q, the OS's session
   * end), before any page's `onBeforeQuit` / `onCloseRequested` handler: the quit is cancelled when
   * it returns (or resolves) `false`. The guards are given 5 seconds together (the deadline a
   * page's guards get); one that throws or runs past it is logged and does not cancel, so a quit
   * is never held for good. While a {@linkcode DesktopExtensionHost.confirm} box opened during the
   * guards' turn is on screen the 5 seconds stop counting, so a guard can await the user's answer;
   * they go on when the box closes. Not for the OS's session end (a logout, a shutdown): its 5
   * seconds always run (and the OS's own deadline, 10 s on macOS and 4 s on Windows), so answer it
   * without asking. A refused OS session end asks the OS to stop it, which it may not honour
   * (macOS ignores an accessory app's refusal). Returns the unsubscribe.
   */
  onBeforeQuit(fn: () => boolean | Promise<boolean>): () => void;
  /**
   * Quit the app, typed: the whole quit again, as `quitApp()` runs it (the other `onBeforeQuit`
   * guards, the pages' `onBeforeQuit` / `onCloseRequested`, the `onAppQuit` hooks), except that
   * this extension's own guards are not asked again: it decided already. For a guard that cancels
   * at once, asks the user, then quits. The approval lasts until the quit goes through or another
   * quit starts (the user, the OS, `quitApp()`), so guards that each ask and quit again never ask
   * one another round in a loop. Called while the guards are being asked, it waits for their
   * answer first. Resolves `true` when the app is quitting, `false` when another guard or a page
   * refused or holds the quit (a page asking its user lets it go itself), or with no desktop
   * runtime. Rejects with a {@linkcode DesktopCapError} (`conflict`) when called from inside this
   * extension's own guard: return `true` from the guard instead.
   */
  quit(): Promise<boolean>;
  /**
   * Call `fn` on every click on one of the app's own Window-menu items
   * (`desktop.menu.window.items`), with the item's `id` and the key window (`{ id, key? }`, or
   * `null` with no window open). Each click is delivered once to each subscriber (and to
   * `runDesktop({ onWindowMenuItem })`), never to the pages. With no window open the clicks arrive
   * from runtime 3.0.0-denext.16; on an older runtime only while the main window is open. A throw
   * or a rejection is logged. Returns the unsubscribe.
   */
  onWindowMenuItem(fn: DesktopWindowMenuItemHandler): () => void;
  /**
   * Call `fn` on every later launch of the app while it runs, forwarded by the single-instance
   * lock (`desktop.app.singleInstance`), with the launch's `args` (after the executable) and `cwd`.
   * It runs after `runDesktop({ onSecondInstance })` opened its window, if any; the deep links and
   * files the launch carried still reach the pages' `onDeepLink` / `onOpenFile`. A throw or a
   * rejection is logged. Never called without denext's pinned runtime. Returns the unsubscribe.
   */
  onSecondInstance(fn: (event: DesktopSecondInstanceEvent) => void | Promise<void>): () => void;
  /**
   * Call `fn` before every top-level navigation of every window, ahead of the navigation guard
   * (`desktop.app.origin`, `allowedNavigationOrigins`), with the `url`, the `window`, its `kind`
   * (`"link"`, `"script"`, `"redirect"`, `"window-open"`, `"other"`) and the `initiator` when the
   * engine says: `event.preventDefault()` refuses it, `event.allow()` loads it in place although
   * the guard would send it to the browser (a refusal wins). Decide synchronously; a throw is
   * logged and decides nothing. Never called on a runtime without the hook (one that publishes no
   * `Deno.desktop.navigationEvents`). Returns the unsubscribe.
   */
  onWillNavigate(fn: DesktopWillNavigateHandler): () => void;
  /** The open windows now (the main window, the tray panel and the opened ones). */
  windows(): readonly DesktopWindowInfo[];
  /** The same store as {@linkcode DesktopCapCtx.secureStore}: this capability's own secrets. */
  readonly secureStore: DesktopSecureStore;
  /**
   * Ask the user with the OS's own message box (NSAlert, TaskDialogIndirect, GtkMessageDialog):
   * app-modal, so it works with no window open — an {@linkcode DesktopExtensionHost.onBeforeQuit}
   * guard after the last window closed, a tray app. Resolves the pressed button's index; a box
   * dismissed without a button (Escape or the close button with no `cancelId`, the app quitting)
   * resolves `cancelId`, or `null` without one. Rejects with a `validation`
   * {@linkcode DesktopCapError} for bad options, and with an `unsupported` one on a runtime without
   * native message boxes (`Deno.desktop.dialog.showMessageBox`, runtime 3.0.0-denext.16). While
   * the box is up during the quit guards' turn their deadline does not count (see
   * {@linkcode DesktopExtensionHost.onBeforeQuit}).
   */
  confirm(options: DesktopConfirmOptions): Promise<number | null>;
  /**
   * Open a window on a page of the app, exactly as `desktop.ts`'s `windows.open` does (the same
   * options, limits and key rules), and return it. Throws on bad options, past
   * `desktop.app.maxWindows`, or with no desktop runtime (an `unsupported`
   * {@linkcode DesktopCapError}).
   */
  openWindow(options: DesktopOpenWindowOptions): DesktopWindowRef;
}

/**
 * A C function `void* fn(void* context)` that {@linkcode DesktopCapCtx.runOnMainThread} calls on the
 * UI thread: a `Deno.UnsafeFnPointer`, a `Deno.UnsafeCallback`, or a function pointer.
 */
export type DesktopMainThreadFn =
  // deno-lint-ignore no-explicit-any
  | Deno.UnsafeFnPointer<any>
  // deno-lint-ignore no-explicit-any
  | Deno.UnsafeCallback<any>
  | Deno.PointerObject;

/**
 * One capability method: an optional input schema (validated before the handler), an optional
 * output schema (strips the result before it reaches the page, in production too), the Deno
 * permissions it needs, an optional per-method timeout, and the handler that runs in the Deno
 * process.
 *
 * Input inference for the PAGE flows from `input`/`output` (read by `denext/desktop/client`'s
 * typed proxy). The HANDLER receives `args` typed as `unknown` (the bridge has already validated it
 * against `input`); read fields off it or cast it to the input schema's output type INSIDE the
 * handler — do not annotate the `args` parameter with a narrower type, as a handler assigned to
 * `(args: unknown) => …` cannot narrow it (parameter contravariance).
 */
export interface DesktopCapabilityMethod<I = unknown, O = unknown> {
  /** Validates the page's arguments; a mismatch is a `validation` error before the handler runs. */
  readonly input?: StandardSchemaV1<unknown>;
  /** Strips the handler's result to the declared shape before it reaches the page. */
  readonly output?: StandardSchemaV1<O>;
  /** The Deno permissions this method needs (drives least-privilege packaging + `doctor`). */
  readonly permissions?: DesktopPermissions;
  /**
   * How long the handler may run before the bridge answers `timeout` and aborts `ctx.signal`.
   * A number of ms, or `false` to wait as long as it takes (a native dialog the user is reading).
   * Defaults to the bridge's default (30 s).
   */
  readonly timeoutMs?: number | false;
  /** Runs in the Deno process with the validated `args` and a {@linkcode DesktopCapCtx}. */
  readonly handler: (args: I, ctx: DesktopCapCtx) => O | Promise<O>;
}

/**
 * A desktop capability: a name (its address on the bridge — an extension's name is its cap name),
 * a set of methods, and the event names it may {@linkcode DesktopCapCtx.emit}. Built-ins live in
 * {@link ./caps}; user extensions are authored with {@linkcode defineDesktopExtension}.
 */
export interface DesktopCapability {
  /** The capability name the page calls (`"secureStore"`, or an extension's own name). */
  readonly name: string;
  /** The methods, keyed by method name. */
  readonly methods: Readonly<Record<string, DesktopCapabilityMethod>>;
  /** The event names this capability may emit (empty when it emits none). */
  readonly events?: readonly string[];
  /**
   * Called when a window starts a NEW top-level page load (a reload or a navigation): the page
   * that owned any per-page state is gone, so release it (keep-awake holds, open handles). Errors
   * are logged, never surfaced. The same idea as the mobile native views' teardown on navigation.
   * It is called for the main window's page loads, with `"main"`, and — only when
   * {@linkcode DesktopCapability.perWindow} is set — for every other window's too, with its id.
   */
  readonly onPageLoad?: (windowId?: string) => void | Promise<void>;
  /**
   * The capability keeps per-page state for each window (keyed by
   * {@linkcode DesktopCapCtx.windowId}), so {@linkcode DesktopCapability.onPageLoad} is called for
   * every window's page loads, not just the main window's.
   */
  readonly perWindow?: boolean;
  /**
   * Called for every window that opens (the main window, the tray panel, the windows pages or
   * `desktop.ts` open) — and, when the capability is registered while windows are open, first for
   * each of them. The same for every capability that defines it, {@linkcode DesktopCapability.perWindow}
   * or not. An error is logged, never surfaced.
   */
  readonly onWindowOpened?: (info: DesktopWindowInfo) => void | Promise<void>;
  /**
   * Called once a window closed for good — never on a reload or a navigation (that is
   * {@linkcode DesktopCapability.onPageLoad}) — with whether the close is part of the app's quit
   * ({@linkcode DesktopWindowClosedInfo.appQuitting}). A promise it returns is waited for, bounded,
   * when the app is quitting; an error is logged, never surfaced, and never keeps a window open.
   */
  readonly onWindowClosed?: (info: DesktopWindowClosedInfo) => void | Promise<void>;
  /**
   * Called once the app is about to quit, after the windows' {@linkcode DesktopCapability.onWindowClosed},
   * and waited for: at most 3 seconds for every capability's `onAppQuit` together, after which the
   * process exits regardless. An error is logged, never surfaced.
   */
  readonly onAppQuit?: () => void | Promise<void>;
  /**
   * Called on every later launch of the app while it runs (`desktop.app.singleInstance`), with its
   * `args` and `cwd`: the static form of {@linkcode DesktopExtensionHost.onSecondInstance}. An
   * error is logged, never surfaced.
   */
  readonly onSecondInstance?: (event: DesktopSecondInstanceEvent) => void | Promise<void>;
  /**
   * Called once, when the app's bridge starts (before any page can call), with the
   * {@linkcode DesktopExtensionHost}: the extension's own process-level `emit` (scoped to its
   * declared {@linkcode DesktopCapability.events}) and `pickedPath`. Keep the host in a module
   * variable so work started outside a method call — by `desktop.ts`, a tray menu, a timer — can
   * stream to the page. An error it throws is logged, never surfaced.
   */
  readonly setup?: (host: DesktopExtensionHost) => void;
}

/**
 * Define a native desktop extension: a capability that runs in the desktop app's Deno process and
 * that the page calls through `denext/desktop/client`'s {@link desktopExtension}. Enable it in
 * `desktop.capabilities.extensions` (a module path). This is an identity helper — it returns its
 * argument unchanged so a `typeof import("./ext.ts")` keeps the exact method types the client's
 * typed proxy reads — and it is not a place for side effects (nothing should run at import).
 *
 * @example
 * ```ts
 * // desktop/extensions/scanner.ts  (runs in the Deno process only)
 * import { defineDesktopExtension } from "denext/desktop";
 * import { z } from "zod";
 * export default defineDesktopExtension({
 *   name: "scanner",
 *   methods: {
 *     listDevices: {
 *       input: z.object({}),
 *       output: z.array(z.string()),
 *       permissions: { ffi: ["./native/libscanner.dylib"] },
 *       handler: () => listDevicesFromFfi(),
 *     },
 *   },
 * });
 * ```
 *
 * @typeParam C The capability's exact shape (preserved for the page's typed client).
 * @param capability The capability definition.
 * @returns The same object, typed as given.
 */
export function defineDesktopExtension<const C extends DesktopCapability>(capability: C): C {
  return capability;
}

/**
 * Throw this from a capability handler to answer the page with a specific error code and a SAFE
 * message. The bridge puts `code`, the message and any `data` into the `{ ok: false, error }`
 * envelope at `status` (default 400). Never encode an absolute path, environment value or stack
 * into the message — it crosses to the page. The code `"unavailable"` is RESERVED (it means the
 * capability/method is not enabled, which makes the page fall back to its web path); use another
 * code for a real failure.
 */
export class DesktopCapError extends Error {
  /** The machine-readable error code the page narrows on. */
  override readonly name = "DesktopCapError";
  /** The error code (not `"unavailable"`, which the bridge reserves). */
  readonly code: string;
  /** The HTTP status for the envelope (the client reads the envelope at any status). */
  readonly status: number;
  /** Structured detail for the page, if any (must be JSON-serialisable and non-sensitive). */
  readonly data?: unknown;

  /**
   * Build a capability error whose envelope crosses safely to the page.
   *
   * @param code The machine-readable error code the page narrows on (never `"unavailable"`, which
   * the bridge reserves for a disabled capability).
   * @param message A SAFE message that crosses to the page — no absolute path, env value or stack.
   * @param options `status` (the HTTP status for the envelope, default 400) and `data` (structured,
   * JSON-serialisable, non-sensitive detail for the page).
   */
  constructor(code: string, message: string, options: { status?: number; data?: unknown } = {}) {
    super(message);
    this.code = code;
    this.status = options.status ?? 400;
    if (options.data !== undefined) this.data = options.data;
  }
}

/**
 * Validate `value` against a Standard Schema, returning the parsed value or the issue messages.
 * A thin wrapper over the schema's own `~standard.validate` (async-aware), matching how
 * `defineApi` validates. Used by the bridge to check a method's `input` and strip its `output`.
 *
 * @param schema The Standard Schema.
 * @param value The value to validate.
 * @returns `{ ok: true, value }` on success, else `{ ok: false, messages }`.
 */
export async function validateStandard<O>(
  schema: StandardSchemaV1<O>,
  value: unknown,
): Promise<{ ok: true; value: O } | { ok: false; messages: string[] }> {
  const result: StandardResult<O> = await schema["~standard"].validate(value);
  if (result.issues === undefined) return { ok: true, value: result.value };
  return { ok: false, messages: result.issues.map((issue) => issue.message) };
}
