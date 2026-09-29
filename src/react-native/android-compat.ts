/**
 * React Native core APIs react-native-web has no module for, which failed an app's build on a
 * named import: `DrawerLayoutAndroid` (a working drawer on every platform) and `Settings`
 * (iOS's `NSUserDefaults` API, over `localStorage`). React Native mode adds both to
 * react-native-web's entry. Nothing here imports react-native-web: the entry itself imports this
 * module, so the drawer is drawn with plain elements.
 *
 * @module
 */

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChildren } from "../jsx/types.ts";
import { useEffect, useImperativeHandle, useRef, useState } from "../runtime/hooks.ts";
import { onBack } from "../mobile/back-handler.ts";

// ---- DrawerLayoutAndroid ------------------------------------------------------------------------

/** `DrawerLayoutAndroid` props. */
export interface DrawerLayoutAndroidProps {
  /** The drawer's content. */
  renderNavigationView: () => VNodeChildren;
  /** The drawer's width in px (default 280). */
  drawerWidth?: number;
  /** `"left"` (default) or `"right"`. */
  drawerPosition?: "left" | "right";
  /** `"unlocked"` (default), `"locked-closed"` or `"locked-open"`. */
  drawerLockMode?: "unlocked" | "locked-closed" | "locked-open";
  /** The drawer's background colour (default white). */
  drawerBackgroundColor?: string;
  /** The drawer opened. */
  onDrawerOpen?: () => void;
  /** The drawer closed. */
  onDrawerClose?: () => void;
  /** The drawer moved (`offset` 0 closed, 1 open: no drag progress here). */
  onDrawerSlide?: (event: { nativeEvent: { offset: number } }) => void;
  /** `"Idle"` or `"Settling"` (no `"Dragging"`: the drawer is not swiped here). */
  onDrawerStateChanged?: (state: "Idle" | "Dragging" | "Settling") => void;
  /** The screen. */
  children?: VNodeChildren;
  /** The container's style. */
  style?: Readonly<Record<string, string | number | undefined>>;
  /** The ref: `openDrawer()` / `closeDrawer()`. */
  ref?: unknown;
  /** Other props (`keyboardDismissMode`, `statusBarBackgroundColor`, …): ignored. */
  [prop: string]: unknown;
}

/** What a `DrawerLayoutAndroid` ref offers. */
interface DrawerLayoutAndroidRef {
  /** Open the drawer. */
  openDrawer(): void;
  /** Close the drawer. */
  closeDrawer(): void;
}

/** The slide's duration, in ms. */
const SLIDE_MS = 250;

/** Report a finished open or close to the props' callbacks. */
function useDrawerEvents(open: boolean, latest: { current: DrawerLayoutAndroidProps }): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const p = latest.current;
    p.onDrawerStateChanged?.("Settling");
    const done = setTimeout(() => {
      const q = latest.current;
      q.onDrawerSlide?.({ nativeEvent: { offset: open ? 1 : 0 } });
      q.onDrawerStateChanged?.("Idle");
      if (open) q.onDrawerOpen?.();
      else q.onDrawerClose?.();
    }, SLIDE_MS);
    return () => clearTimeout(done);
  }, [open]);
}

/** Close the open drawer on Escape and the Android back button. */
function useDrawerDismiss(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return;
    const stopBack = onBack(() => (close(), true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    globalThis.addEventListener?.("keydown", onKey);
    return () => {
      stopBack();
      globalThis.removeEventListener?.("keydown", onKey);
    };
  }, [active]);
}

/** The scrim over the screen while the drawer is open; a tap closes it. */
function scrim(shown: boolean, close: () => void): VNode {
  return h("div", {
    "aria-hidden": "true",
    onClick: close,
    style: {
      position: "absolute",
      inset: 0,
      background: "rgba(0, 0, 0, 0.5)",
      opacity: shown ? 1 : 0,
      pointerEvents: shown ? "auto" : "none",
      transition: `opacity ${SLIDE_MS}ms ease`,
    },
  });
}

/** The drawer panel, slid off its side while closed. */
function panel(props: DrawerLayoutAndroidProps, shown: boolean): VNode {
  const right = props.drawerPosition === "right";
  return h(
    "div",
    {
      role: "navigation",
      inert: shown ? undefined : "",
      style: {
        position: "absolute",
        top: 0,
        bottom: 0,
        [right ? "right" : "left"]: 0,
        width: props.drawerWidth ?? 280,
        maxWidth: "100%",
        display: "flex",
        flexDirection: "column",
        background: props.drawerBackgroundColor ?? "#fff",
        transform: shown ? "none" : right ? "translateX(100%)" : "translateX(-100%)",
        transition: `transform ${SLIDE_MS}ms ease`,
      },
    },
    props.renderNavigationView(),
  );
}

/** Whether the drawer shows: forced by a `locked-*` mode, else the open state. */
function drawerShown(lock: DrawerLayoutAndroidProps["drawerLockMode"], open: boolean): boolean {
  if (lock === "locked-open") return true;
  return lock === "locked-closed" ? false : open;
}

/**
 * React Native's `DrawerLayoutAndroid`, on every platform: a panel that slides in from the side
 * over the screen, opened by the ref's `openDrawer()` and closed by `closeDrawer()`, a tap on
 * the scrim, Escape or the Android back button. There is no edge swipe here.
 *
 * @param props The drawer content, position, lock mode and callbacks.
 * @returns The layout.
 */
export function DrawerLayoutAndroid(props: DrawerLayoutAndroidProps): VNode {
  const [open, setOpen] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const unlocked = (props.drawerLockMode ?? "unlocked") === "unlocked";
  const shown = drawerShown(props.drawerLockMode, open);
  // A locked drawer ignores open / close requests.
  const change = (next: boolean) => {
    if ((latest.current.drawerLockMode ?? "unlocked") === "unlocked") setOpen(next);
  };
  const close = () => change(false);
  useImperativeHandle(props.ref as never, (): DrawerLayoutAndroidRef => ({
    openDrawer: () => change(true),
    closeDrawer: close,
  }), []);
  useDrawerEvents(shown, latest);
  useDrawerDismiss(shown && unlocked, close);
  return h(
    "div",
    {
      "data-denext-drawer-layout": "",
      style: { position: "relative", overflow: "hidden", flex: 1, display: "flex", ...props.style },
    },
    h("div", { style: { flex: 1, display: "flex", flexDirection: "column" } }, props.children),
    scrim(shown, close),
    panel(props, shown),
  );
}

// ---- Settings --------------------------------------------------------------------------------

/** The `localStorage` key prefix of a setting. */
const PREFIX = "denext:rn-settings:";

/** A watch: the keys and the callback. */
interface Watch {
  readonly keys: readonly string[];
  readonly callback: () => void;
}

/** The watches by id (made on first use). */
let watches: Map<number, Watch> | undefined;
/** The last watch id handed out. */
let lastWatchId = 0;

/** `localStorage`, or undefined where there is none (SSR, a locked-down frame). */
function storage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return undefined;
  }
}

/** React Native's `Settings` (iOS `NSUserDefaults`), over `localStorage`. */
export interface SettingsStatic {
  /** The value stored for `key` (undefined when none). */
  get(key: string): unknown;
  /** Store each key of `settings` (JSON values). */
  set(settings: Record<string, unknown>): void;
  /** Call `callback` when one of `keys` is set through {@linkcode SettingsStatic.set}; returns its id. */
  watchKeys(keys: string | string[], callback: () => void): number;
  /** Stop the watch `watchId`. */
  clearWatch(watchId: number): void;
}

/**
 * React Native's `Settings` on every platform: values stored in `localStorage` (as JSON, under
 * a `denext:rn-settings:` prefix), so they last across launches in the shell and the browser.
 * `watchKeys` fires for changes made through `Settings.set` in this page.
 */
export const Settings: SettingsStatic = {
  get(key) {
    const raw = storage()?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
  set(settings) {
    const store = storage();
    const changed = Object.keys(settings);
    for (const key of changed) {
      const value = settings[key];
      if (value === undefined) store?.removeItem(PREFIX + key);
      else store?.setItem(PREFIX + key, JSON.stringify(value));
    }
    for (const watch of [...(watches?.values() ?? [])]) {
      if (watch.keys.some((k) => changed.includes(k))) watch.callback();
    }
  },
  watchKeys(keys, callback) {
    const id = ++lastWatchId;
    (watches ??= new Map()).set(id, { keys: Array.isArray(keys) ? keys : [keys], callback });
    return id;
  },
  clearWatch(watchId) {
    watches?.delete(watchId);
  },
};
