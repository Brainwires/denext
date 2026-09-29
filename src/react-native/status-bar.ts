/**
 * React Native's `StatusBar` for React Native mode, over `denext/mobile`'s system bars
 * (Capacitor 8's `SystemBars`) and safe-area insets. react-native-web ships it as a mock. The
 * `expo-status-bar` shim renders this same component.
 *
 * @module
 */

import { useEffect, useRef } from "../runtime/hooks.ts";
import { isNativeShell, nativePlatform } from "../mobile/bridge.ts";
import { setSystemBars, type SystemBarsStyle } from "../mobile/system-bars.ts";

/** The status bar's content color, as React Native names it. */
export type StatusBarStyle = "default" | "light-content" | "dark-content";

/** How the status bar hides and shows. */
export type StatusBarAnimation = "none" | "fade" | "slide";

/** Props of React Native's `StatusBar`. */
export interface StatusBarProps {
  /** Animate `barStyle` and `hidden` changes. */
  readonly animated?: boolean;
  /** The content color: `"light-content"` over a dark app, `"dark-content"` over a light one. */
  readonly barStyle?: StatusBarStyle | null;
  /** Hide the status bar. */
  readonly hidden?: boolean;
  /** The hide / show animation (`"slide"` plays as a fade). */
  readonly showHideTransition?: StatusBarAnimation | null;
  /** Android: a color painted behind the status bar (the app draws edge to edge). */
  readonly backgroundColor?: string;
  /** Android: `true` leaves the area behind the status bar to the app (no `backgroundColor`). */
  readonly translucent?: boolean;
  /** iOS: the network activity indicator (gone since iOS 13; ignored). */
  readonly networkActivityIndicatorVisible?: boolean;
}

/** A stack entry (`StatusBar.pushStackEntry`). */
export interface StatusBarStackEntry {
  readonly props: StatusBarProps;
}

/** React Native's `StatusBar`: the component and its static methods. */
export interface StatusBarStatic {
  (props: StatusBarProps): null;
  /** The status bar's height in px (Android shell; `undefined` elsewhere, as on iOS). */
  readonly currentHeight: number | undefined;
  setBarStyle(style: StatusBarStyle, animated?: boolean): void;
  setHidden(hidden: boolean, animation?: StatusBarAnimation): void;
  setBackgroundColor(color: string, animated?: boolean): void;
  setTranslucent(translucent: boolean): void;
  setNetworkActivityIndicatorVisible(visible: boolean): void;
  pushStackEntry(props: StatusBarProps): StatusBarStackEntry;
  popStackEntry(entry: StatusBarStackEntry): void;
  replaceStackEntry(entry: StatusBarStackEntry, props: StatusBarProps): StatusBarStackEntry;
}

/** The merged status bar a stack describes. */
interface Resolved {
  barStyle: StatusBarStyle;
  hidden: boolean;
  animated: boolean;
  showHideTransition: StatusBarAnimation;
  backgroundColor?: string;
  translucent: boolean;
}

/** The mounted entries, the static methods' defaults, and what was last applied. */
interface StatusBarRegistry {
  readonly defaults: Resolved;
  readonly stack: StatusBarStackEntry[];
  applied: Partial<Resolved>;
  scheduled: boolean;
  strip?: { remove(): void; style: { setProperty(n: string, v: string): void } };
}

let registry: StatusBarRegistry | undefined;

const STYLE: Readonly<Record<StatusBarStyle, SystemBarsStyle>> = {
  "light-content": "dark",
  "dark-content": "light",
  default: "auto",
};

/** The registry, created on first use. */
function statusBarRegistry(): StatusBarRegistry {
  return registry ??= {
    defaults: {
      barStyle: "default",
      hidden: false,
      animated: false,
      showHideTransition: "fade",
      translucent: false,
    },
    stack: [],
    applied: {},
    scheduled: false,
  };
}

/** Test hook: forget the stack, the defaults and what was applied. */
export function resetStatusBarForTesting(): void {
  registry?.strip?.remove();
  registry = undefined;
}

/** The defaults overridden by each entry's set props, oldest first (React Native's merge). */
function merged(reg: StatusBarRegistry): Resolved {
  const out: Resolved = { ...reg.defaults };
  for (const { props } of reg.stack) {
    if (props.barStyle != null) out.barStyle = props.barStyle;
    if (props.hidden != null) out.hidden = props.hidden;
    if (props.animated != null) out.animated = props.animated;
    if (props.showHideTransition != null) out.showHideTransition = props.showHideTransition;
    if (props.backgroundColor != null) out.backgroundColor = props.backgroundColor;
    if (props.translucent != null) out.translucent = props.translucent;
  }
  return out;
}

/** Tell the system bars about a style change. */
function applyStyle(style: StatusBarStyle): void {
  setSystemBars({ style: STYLE[style] ?? "auto", bar: "status" }).catch(() => {});
}

/** Hide or show the status bar. */
function applyHidden(hidden: boolean, animation: "fade" | "none"): void {
  setSystemBars({ hidden, bar: "status", animation }).catch(() => {});
}

/** The CSS length of the status bar area: Capacitor's injected inset, else `env()`. */
const TOP_INSET = "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";

/**
 * Android: paint `color` behind the status bar with a fixed strip the height of the top inset
 * (Capacitor 8 draws the app edge to edge, so the bar has no background of its own); no color,
 * or `translucent`, removes it.
 */
function applyBackground(reg: StatusBarRegistry, color: string | undefined, translucent: boolean) {
  if (nativePlatform() !== "android" || typeof document === "undefined") return;
  if (color === undefined || translucent) {
    reg.strip?.remove();
    reg.strip = undefined;
    return;
  }
  if (!reg.strip) {
    const strip = document.createElement("div");
    strip.setAttribute("aria-hidden", "true");
    strip.setAttribute("data-denext-status-bar-background", "");
    const style = strip.style;
    for (
      const [name, value] of Object.entries({
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        height: TOP_INSET,
        "z-index": "2147483646",
        "pointer-events": "none",
      })
    ) style.setProperty(name, value);
    document.body?.appendChild(strip);
    reg.strip = strip;
  }
  reg.strip.style.setProperty("background", color);
}

/** Apply what changed between what was last applied and the merged stack. */
function flush(reg: StatusBarRegistry): void {
  reg.scheduled = false;
  if (!isNativeShell()) return;
  const next = merged(reg);
  const { applied } = reg;
  if (applied.barStyle !== next.barStyle) applyStyle(next.barStyle);
  if (applied.hidden !== next.hidden) {
    applyHidden(next.hidden, next.animated && next.showHideTransition !== "none" ? "fade" : "none");
  }
  if (
    applied.backgroundColor !== next.backgroundColor || applied.translucent !== next.translucent
  ) {
    applyBackground(reg, next.backgroundColor, next.translucent);
  }
  reg.applied = next;
}

/** Apply the stack after the current task (a commit's pushes and pops coalesce). */
function schedule(reg: StatusBarRegistry): void {
  if (reg.scheduled) return;
  reg.scheduled = true;
  queueMicrotask(() => flush(reg));
}

/** Measure the top safe-area inset in px (0 when it cannot be measured). */
function measureTopInset(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
  const probe = document.createElement("div");
  probe.style.cssText = `position:fixed;top:0;visibility:hidden;padding-top:${TOP_INSET}`;
  document.documentElement.appendChild(probe);
  const px = Number.parseFloat(getComputedStyle(probe).paddingTop);
  probe.remove();
  return Number.isFinite(px) ? px : 0;
}

/** Push a stack entry. */
function pushEntry(props: StatusBarProps): StatusBarStackEntry {
  const reg = statusBarRegistry();
  const entry = { props: { ...props } };
  reg.stack.push(entry);
  schedule(reg);
  return entry;
}

/** Pop a stack entry. */
function popEntry(entry: StatusBarStackEntry): void {
  const reg = statusBarRegistry();
  const at = reg.stack.indexOf(entry);
  if (at >= 0) reg.stack.splice(at, 1);
  schedule(reg);
}

/** Replace a stack entry in place (a pop and push that keeps its position). */
function replaceEntry(entry: StatusBarStackEntry, props: StatusBarProps): StatusBarStackEntry {
  const reg = statusBarRegistry();
  const next = { props: { ...props } };
  const at = reg.stack.indexOf(entry);
  if (at >= 0) reg.stack[at] = next;
  else reg.stack.push(next);
  schedule(reg);
  return next;
}

/** The component: pushes its props as a stack entry while mounted, replacing it on change. */
function StatusBarComponent(props: StatusBarProps): null {
  const entry = useRef<StatusBarStackEntry | null>(null);
  const { animated, barStyle, hidden, showHideTransition, backgroundColor, translucent } = props;
  useEffect(() => {
    const own = { animated, barStyle, hidden, showHideTransition, backgroundColor, translucent };
    entry.current = entry.current ? replaceEntry(entry.current, own) : pushEntry(own);
  }, [animated, barStyle, hidden, showHideTransition, backgroundColor, translucent]);
  useEffect(() => () => {
    if (entry.current) popEntry(entry.current);
    entry.current = null;
  }, []);
  return null;
}

/** The static methods: each changes the defaults under the stack and applies at once. */
function statusBarStatics(): Omit<StatusBarStatic, "currentHeight"> {
  return {
    setBarStyle(style: StatusBarStyle, animated = false) {
      const reg = statusBarRegistry();
      Object.assign(reg.defaults, { barStyle: style, animated });
      if (!isNativeShell()) return;
      applyStyle(style);
      reg.applied = { ...reg.applied, barStyle: style };
    },
    setHidden(hidden: boolean, animation: StatusBarAnimation = "none") {
      const reg = statusBarRegistry();
      Object.assign(reg.defaults, { hidden, showHideTransition: animation });
      if (!isNativeShell()) return;
      applyHidden(hidden, animation === "none" ? "none" : "fade");
      reg.applied = { ...reg.applied, hidden };
    },
    setBackgroundColor(color: string) {
      const reg = statusBarRegistry();
      reg.defaults.backgroundColor = color;
      schedule(reg);
    },
    setTranslucent(translucent: boolean) {
      const reg = statusBarRegistry();
      reg.defaults.translucent = translucent;
      schedule(reg);
    },
    setNetworkActivityIndicatorVisible(_visible: boolean) {},
    pushStackEntry: pushEntry,
    popStackEntry: popEntry,
    replaceStackEntry: replaceEntry,
  };
}

/**
 * React Native's `StatusBar`, backed by Capacitor 8's `SystemBars` inside the native shell
 * (`denext mobile add system-bars`): `barStyle` sets the status bar's style
 * (`"light-content"` → light icons, `"dark-content"` → dark ones, `"default"` → the system's),
 * `hidden` hides it (animated as a fade when `animated`), and on Android `backgroundColor` is
 * painted behind it by a fixed strip the height of the top inset, since Capacitor 8 draws the
 * app edge to edge (`translucent` removes the strip). Mounted `<StatusBar>`s stack as in React
 * Native: the newest one's set props win, and unmounting restores the one below. The static
 * methods change the defaults under the stack and apply at once. `currentHeight` is the top
 * inset in the Android shell. In a browser the page cannot style the browser's chrome, so all
 * of this does nothing there.
 *
 * @example
 * ```tsx
 * import { StatusBar } from "react-native";
 *
 * export function Player() {
 *   return <StatusBar hidden animated showHideTransition="fade" />;
 * }
 * ```
 */
export const StatusBar: StatusBarStatic = /* @__PURE__ */ Object.defineProperty(
  Object.assign(StatusBarComponent, statusBarStatics()),
  "currentHeight",
  {
    get: () => (nativePlatform() === "android" ? measureTopInset() : undefined),
    enumerable: true,
  },
) as unknown as StatusBarStatic;
