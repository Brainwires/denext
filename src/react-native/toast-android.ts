/**
 * React Native's `ToastAndroid` for React Native mode: `@capacitor/toast`'s system toast in the
 * Android shell when that plugin is installed, else an in-page toast drawn like Android's (a
 * dark rounded bubble near the bottom, announced to screen readers). react-native-web has no
 * `ToastAndroid`, so an import of it was a build error.
 *
 * @module
 */

import { nativePlatform } from "../mobile/bridge.ts";
import { nativePlugin } from "../mobile/plugin.ts";

/** React Native's `ToastAndroid` module. */
export interface ToastAndroidStatic {
  /** A short toast (about 2 seconds): Android's `Toast.LENGTH_SHORT`, 0. */
  readonly SHORT: number;
  /** A long toast (about 3.5 seconds): Android's `Toast.LENGTH_LONG`, 1. */
  readonly LONG: number;
  /** At the top: Android's `Gravity.TOP | CENTER_HORIZONTAL`, 49. */
  readonly TOP: number;
  /** At the bottom (the default): Android's `Gravity.BOTTOM | CENTER_HORIZONTAL`, 81. */
  readonly BOTTOM: number;
  /** In the middle: Android's `Gravity.CENTER`, 17. */
  readonly CENTER: number;
  /** Show `message` for `duration` (`SHORT` or `LONG`) at the bottom. */
  show(message: string, duration: number): void;
  /** Show `message` for `duration` at `gravity` (`TOP`, `BOTTOM` or `CENTER`). */
  showWithGravity(message: string, duration: number, gravity: number): void;
  /** As `showWithGravity`, moved by `xOffset` / `yOffset` px (the in-page toast only). */
  showWithGravityAndOffset(
    message: string,
    duration: number,
    gravity: number,
    xOffset: number,
    yOffset: number,
  ): void;
}

/** The JS side of `@capacitor/toast`. */
interface ToastPlugin {
  show(options: {
    text: string;
    duration?: "short" | "long";
    position?: "top" | "center" | "bottom";
  }): Promise<void>;
}

/** The slice of a DOM element the in-page toast uses. */
interface ToastEl {
  setAttribute(name: string, value: string): void;
  readonly style: { setProperty(name: string, value: string): void };
  remove(): void;
  textContent: string;
}

/** The slice of `document` the in-page toast uses. */
interface ToastDocument {
  createElement(tag: string): ToastEl;
  body?: { appendChild(node: unknown): unknown } | null;
}

/** Android's toast constants. */
const SHORT = 0;
const LONG = 1;
const TOP = 49;
const BOTTOM = 81;
const CENTER = 17;

/** How long Android shows a short and a long toast, in ms. */
const SHORT_MS = 2000;
const LONG_MS = 3500;

/** One queued toast. */
interface Toast {
  readonly message: string;
  readonly long: boolean;
  readonly position: "top" | "center" | "bottom";
  readonly x: number;
  readonly y: number;
}

/** The tail of the in-page queue: toasts show one after another, as Android's do. */
let queue: Promise<void> = Promise.resolve();

/** `gravity` as a position (anything unknown is Android's default, the bottom). */
function positionOf(gravity: number): Toast["position"] {
  return gravity === TOP ? "top" : gravity === CENTER ? "center" : "bottom";
}

/**
 * The in-page toast's placement for `toast`. As on Android, a positive `y` offset moves the
 * toast away from its edge: down from the top, up from the bottom.
 */
function placement(toast: Toast): Record<string, string> {
  const shift = (y: number) => `translateX(-50%) translate(${toast.x}px, ${y}px)`;
  switch (toast.position) {
    case "top":
      return { top: "calc(64px + env(safe-area-inset-top, 0px))", transform: shift(toast.y) };
    case "center":
      return { top: "50%", transform: `${shift(toast.y)} translateY(-50%)` };
    default:
      return {
        bottom: "calc(64px + env(safe-area-inset-bottom, 0px))",
        transform: shift(-toast.y),
      };
  }
}

/** Show `toast` in the page for its duration; resolves once it is gone. */
function showInPage(toast: Toast): Promise<void> {
  const doc = (globalThis as { document?: ToastDocument }).document;
  if (typeof doc?.createElement !== "function" || !doc.body) return Promise.resolve();
  const el = doc.createElement("div");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("data-denext-toast", "");
  el.textContent = toast.message;
  const styles: Record<string, string> = {
    position: "fixed",
    left: "50%",
    "z-index": "2147483647",
    "max-width": "min(80vw, 480px)",
    padding: "10px 16px",
    "border-radius": "20px",
    background: "rgba(40, 40, 40, 0.92)",
    color: "#fff",
    font: "14px/20px Roboto, system-ui, sans-serif",
    "text-align": "center",
    "box-shadow": "0 2px 6px rgba(0, 0, 0, 0.3)",
    "pointer-events": "none",
    ...placement(toast),
  };
  for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value);
  doc.body.appendChild(el);
  return new Promise((resolve) =>
    setTimeout(() => {
      el.remove();
      resolve();
    }, toast.long ? LONG_MS : SHORT_MS)
  );
}

/** Show `toast`: the system toast in the Android shell with `@capacitor/toast`, else in-page. */
function show(toast: Toast): void {
  const message = toast.message;
  const plugin = nativePlatform() === "android"
    ? nativePlugin<ToastPlugin>("Toast", ["show"])
    : undefined;
  if (plugin) {
    plugin.show({
      text: message,
      duration: toast.long ? "long" : "short",
      position: toast.position,
    }).catch(() => {});
    return;
  }
  queue = queue.then(() => showInPage(toast), () => showInPage(toast));
}

/** A toast from `ToastAndroid`'s arguments. */
function toastOf(
  message: unknown,
  duration: number,
  gravity: number,
  x = 0,
  y = 0,
): Toast {
  return {
    message: String(message ?? ""),
    long: duration === LONG,
    position: positionOf(gravity),
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

/**
 * React Native's `ToastAndroid`, on every platform React Native mode runs on:
 *
 * - in the Android shell with `@capacitor/toast` installed (`npm install @capacitor/toast`,
 *   then `npx cap sync`), Android's own toast: `SHORT` / `LONG`, and `TOP` / `CENTER` /
 *   `BOTTOM` (Android 11+ ignores the gravity of a text toast, as it does in React Native);
 * - everywhere else (the iOS shell, a browser, Deno Desktop, the Android shell without the
 *   plugin) an in-page toast styled like Android's: a dark rounded bubble 64 px above the
 *   bottom (or below the top, or centred) over the safe area, `role="status"` so a screen
 *   reader announces it, shown for 2 s (`SHORT`) or 3.5 s (`LONG`). Toasts queue.
 *
 * `showWithGravityAndOffset`'s offsets move the in-page toast; the system toast ignores them.
 * React Native's `ToastAndroid` does nothing on iOS; here it shows the in-page toast there too.
 *
 * @example
 * ```ts
 * import { ToastAndroid } from "react-native";
 *
 * ToastAndroid.show("Saved", ToastAndroid.SHORT);
 * ToastAndroid.showWithGravity("Offline", ToastAndroid.LONG, ToastAndroid.TOP);
 * ```
 */
export const ToastAndroid: ToastAndroidStatic = {
  SHORT,
  LONG,
  TOP,
  BOTTOM,
  CENTER,
  show(message, duration) {
    show(toastOf(message, duration, BOTTOM));
  },
  showWithGravity(message, duration, gravity) {
    show(toastOf(message, duration, gravity));
  },
  showWithGravityAndOffset(message, duration, gravity, xOffset, yOffset) {
    show(toastOf(message, duration, gravity, xOffset, yOffset));
  },
};

/** Forget queued in-page toasts (tests). */
export function resetToastAndroidForTesting(): void {
  queue = Promise.resolve();
}
