/**
 * On-screen keyboard state for `denext/mobile`: whether the keyboard is up and how tall it is,
 * from `@capacitor/keyboard`'s will-show / will-hide events in the shell, else from the browser
 * (the VirtualKeyboard API when the page opted into it, otherwise the visual viewport).
 *
 * @module
 */

import { useEffect, useState } from "../runtime/hooks.ts";
import { nativePlatform } from "./bridge.ts";
import { watchInset, watchShellKeyboard } from "./keyboard.ts";
import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/** The keyboard as {@linkcode useKeyboard} and {@linkcode onKeyboardChange} report it. */
export interface KeyboardState {
  /** Whether the on-screen keyboard is up (or on its way up). */
  readonly visible: boolean;
  /** The keyboard's height in CSS px (`0` while hidden). */
  readonly height: number;
  /**
   * How long the keyboard's show / hide animation takes, in ms, where the platform animates it
   * and the value is known: `250` in the iOS shell (UIKit's keyboard duration). Absent on
   * Android (its will- and did- events arrive together) and on the web.
   */
  readonly animationDuration?: number;
}

/**
 * How `@capacitor/keyboard` resizes the app when the keyboard shows (iOS only): the whole
 * WebView (`"native"`, the plugin's default), only `<body>`, only `ion-app`, or nothing
 * (`"none"`: the keyboard covers the page, and {@linkcode KeyboardAvoidingView} lifts it).
 */
export type KeyboardResizeMode = "native" | "body" | "ionic" | "none";

/** The payload of `@capacitor/keyboard`'s `keyboardWillShow`. */
interface KeyboardInfo {
  keyboardHeight?: number;
}

/** The JS side of `@capacitor/keyboard` (the slice denext calls). */
interface KeyboardPlugin {
  hide(): Promise<void>;
  setResizeMode(options: { mode: KeyboardResizeMode }): Promise<void>;
  getResizeMode?(): Promise<{ mode?: string }>;
  addListener(
    eventName: "keyboardWillShow" | "keyboardWillHide",
    listener: (info?: KeyboardInfo) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

/** The slice of the VirtualKeyboard API (Chromium) the web path reads. */
interface VirtualKeyboardLike {
  overlaysContent?: boolean;
  boundingRect?: { height?: number };
  addEventListener(type: "geometrychange", listener: () => void): void;
  removeEventListener(type: "geometrychange", listener: () => void): void;
}

/** A hidden keyboard, the state before any event. */
const HIDDEN: KeyboardState = { visible: false, height: 0 };

/** UIKit's keyboard show / hide duration (`UIKeyboardAnimationDurationUserInfoKey`), in ms. */
const IOS_KEYBOARD_MS = 250;

/**
 * The smallest visual-viewport loss the web path calls a keyboard. Pinch-zoom and browser
 * toolbars shrink the visual viewport by less than any on-screen keyboard.
 */
const WEB_KEYBOARD_MIN_PX = 100;

const RESIZE_MODES: readonly KeyboardResizeMode[] = ["native", "body", "ionic", "none"];

/** The native Keyboard plugin, when the shell has it. */
function keyboardPlugin(): KeyboardPlugin | undefined {
  return nativePlugin<KeyboardPlugin>("Keyboard", ["addListener", "hide"]);
}

/** A keyboard height as whole, non-negative px. */
function wholePx(height: number | undefined): number {
  return typeof height === "number" && Number.isFinite(height)
    ? Math.max(0, Math.round(height))
    : 0;
}

/** Report the native plugin's will-show / will-hide events; returns a stop function. */
function watchNative(plugin: KeyboardPlugin, emit: (state: KeyboardState) => void): () => void {
  const duration = nativePlatform() === "ios" ? IOS_KEYBOARD_MS : undefined;
  const timed = (state: KeyboardState): KeyboardState =>
    duration === undefined ? state : { ...state, animationDuration: duration };
  const offShow = listenerDisposer(
    plugin.addListener(
      "keyboardWillShow",
      (info) => emit(timed({ visible: true, height: wholePx(info?.keyboardHeight) })),
    ),
  );
  const offHide = listenerDisposer(
    plugin.addListener("keyboardWillHide", () => emit(timed(HIDDEN))),
  );
  return () => {
    offShow();
    offHide();
  };
}

/** `navigator.virtualKeyboard`, only when the page set `overlaysContent` (it then reports). */
function virtualKeyboard(): VirtualKeyboardLike | undefined {
  const nav = (globalThis as { navigator?: { virtualKeyboard?: VirtualKeyboardLike } }).navigator;
  const vk = nav?.virtualKeyboard;
  return vk?.overlaysContent === true && typeof vk.addEventListener === "function" ? vk : undefined;
}

/** Report the VirtualKeyboard API's height now and on every geometry change. */
function watchVirtualKeyboard(vk: VirtualKeyboardLike, onHeight: (px: number) => void): () => void {
  const update = () => onHeight(wholePx(vk.boundingRect?.height));
  vk.addEventListener("geometrychange", update);
  update();
  return () => vk.removeEventListener("geometrychange", update);
}

/** The browser's view of the keyboard: VirtualKeyboard when opted in, else the visual viewport. */
function watchWeb(emit: (state: KeyboardState) => void): () => void {
  const vk = virtualKeyboard();
  if (vk) {
    return watchVirtualKeyboard(vk, (px) => emit(px > 0 ? { visible: true, height: px } : HIDDEN));
  }
  return watchInset((px) =>
    emit(px >= WEB_KEYBOARD_MIN_PX ? { visible: true, height: px } : HIDDEN)
  );
}

/**
 * Call `onChange` with the keyboard's state each time it changes (a state equal to the last
 * one reported is skipped, starting from hidden). Returns a stop function.
 */
function watchKeyboard(onChange: (state: KeyboardState) => void): () => void {
  let last = HIDDEN;
  const push = (state: KeyboardState) => {
    if (state.visible === last.visible && state.height === last.height) return;
    last = state;
    onChange(state);
  };
  const plugin = keyboardPlugin();
  return plugin ? watchNative(plugin, push) : watchWeb(push);
}

/**
 * Call `cb` each time the on-screen keyboard shows, hides or changes height.
 *
 * - Inside the native shell with `@capacitor/keyboard` installed (`denext mobile add
 *   keyboard`), on the plugin's `keyboardWillShow` / `keyboardWillHide`: before the keyboard
 *   animates, with its height and (iOS) the animation's duration.
 * - On the web, from `navigator.virtualKeyboard` when the page set its `overlaysContent`, else
 *   from the visual viewport (a loss of 100 px or more at the bottom counts as a keyboard). The
 *   visual viewport changes only once the keyboard is up, so the web path reports late.
 *
 * Nothing is reported for the initial hidden state; a keyboard already up when subscribing is
 * reported at once on the web path. SSR-safe: without a `window` nothing is ever reported.
 *
 * @param cb Called with the new {@linkcode KeyboardState}.
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onKeyboardChange } from "denext/mobile";
 *
 * const stop = onKeyboardChange(({ visible }) => {
 *   document.body.classList.toggle("keyboard-up", visible);
 * });
 * ```
 */
export function onKeyboardChange(cb: (state: KeyboardState) => void): () => void {
  return watchKeyboard(cb);
}

/**
 * Hook form of {@linkcode onKeyboardChange}: the keyboard's current state, updated on every
 * change until unmount. It reads `{ visible: false, height: 0 }` during SSR and before mount.
 *
 * @returns The latest {@linkcode KeyboardState}.
 * @example
 * ```tsx
 * "use client";
 * import { useKeyboard } from "denext/mobile";
 *
 * export function TabBar() {
 *   const { visible } = useKeyboard();
 *   return visible ? null : <nav>…</nav>; // hide the tab bar while typing
 * }
 * ```
 */
export function useKeyboard(): KeyboardState {
  const [state, setState] = useState<KeyboardState>(HIDDEN);
  useEffect(() => watchKeyboard(setState), []);
  return state;
}

/**
 * Dismiss the on-screen keyboard: `Keyboard.hide()` in the native shell with
 * `@capacitor/keyboard`, else by blurring the focused element (which closes the keyboard in
 * mobile browsers). Does nothing during SSR.
 *
 * @returns A promise that settles once the keyboard was asked to hide; it rejects if the
 * native plugin does.
 * @example
 * ```tsx
 * "use client";
 * import { hideKeyboard } from "denext/mobile";
 *
 * export function Done() {
 *   return <button type="button" onClick={() => hideKeyboard()}>Done</button>;
 * }
 * ```
 */
export async function hideKeyboard(): Promise<void> {
  const plugin = keyboardPlugin();
  if (plugin) return await plugin.hide();
  const doc = (globalThis as { document?: { activeElement?: { blur?: () => void } | null } })
    .document;
  const active = doc?.activeElement;
  if (typeof active?.blur === "function") active.blur();
}

/**
 * Change how the iOS shell resizes the app when the keyboard shows ({@linkcode
 * KeyboardResizeMode}), through `Keyboard.setResizeMode`. `@capacitor/keyboard` supports it on
 * iOS only, so on Android, on the web and without the plugin this does nothing (Android resizes
 * the WebView itself). The startup mode is `plugins.Keyboard.resize` in `capacitor.config`.
 *
 * @param mode `"native"`, `"body"`, `"ionic"` or `"none"`.
 * @returns A promise that settles once the mode is set; it rejects with a `TypeError` for an
 * unknown mode, or if the native plugin rejects.
 * @example
 * ```ts
 * import { setKeyboardResizeMode } from "denext/mobile";
 * // Let the keyboard cover the page; <KeyboardStickyView> lifts the composer itself.
 * await setKeyboardResizeMode("none");
 * ```
 */
export async function setKeyboardResizeMode(mode: KeyboardResizeMode): Promise<void> {
  if (!RESIZE_MODES.includes(mode)) {
    throw new TypeError(`setKeyboardResizeMode: unknown mode "${String(mode)}"`);
  }
  if (nativePlatform() !== "ios") return;
  const plugin = nativePlugin<KeyboardPlugin>("Keyboard", ["setResizeMode"]);
  if (plugin) await plugin.setResizeMode({ mode });
}

/** How far the keyboard covers the page's layout viewport, and how fast it moves. */
export interface KeyboardOverlap {
  /** The covered height in CSS px (`0` once the WebView has resized around the keyboard). */
  readonly px: number;
  /** The keyboard's animation duration in ms, when the change moves with the keyboard. */
  readonly duration?: number;
  /**
   * The keyboard's height, covering the page or not (absent: `px`). In the iOS shell `px` falls
   * below it once the shell has resized the app around the keyboard; the difference is what
   * the resize took.
   */
  readonly height?: number;
}

/** The web overlap: VirtualKeyboard when the page opted in, else the visual viewport's loss. */
function watchWebOverlap(emit: (overlap: KeyboardOverlap) => void): () => void {
  const vk = virtualKeyboard();
  return vk ? watchVirtualKeyboard(vk, (px) => emit({ px })) : watchInset((px) => emit({ px }));
}

/**
 * Report how much of the layout viewport the keyboard covers, now and on every change: the
 * part {@linkcode KeyboardAvoidingView} and {@linkcode KeyboardStickyView} move out of its way.
 * Where the WebView resizes around the keyboard that part shrinks as the resize lands, so
 * nothing is lifted twice. In the iOS shell with `@capacitor/keyboard` it follows will-show /
 * will-hide (animated over the keyboard's duration) less however far the shell has resized the
 * WebView / `<body>` / `ion-app` since, which it does only after the keyboard's animation: the
 * whole keyboard until then, and `0` once it has (at once, with no animation; with
 * `resize: "none"` the whole keyboard throughout). Everywhere else it is the visual viewport's
 * loss (Android resizes the WebView itself, so that is 0). Internal to `denext/mobile`; not
 * re-exported.
 */
export function watchKeyboardOverlap(emit: (overlap: KeyboardOverlap) => void): () => void {
  let last: KeyboardOverlap | undefined;
  const shell = watchShellKeyboard(({ px, height, animated }) => {
    if (last && last.px === px && last.height === height) return;
    last = { px, height, ...(animated ? { duration: IOS_KEYBOARD_MS } : {}) };
    emit(last);
  });
  return shell ?? watchWebOverlap(emit);
}
