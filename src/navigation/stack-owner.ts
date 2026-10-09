/**
 * What every owner of a `StackView` shares, whichever router it binds to (`StackLayout` for
 * the App Router, `HistoryStack` for a history source): the owner's render state (the tab it
 * sits in, a re-render trigger, the `setOptions` overrides), the navigator its screens get,
 * the registration that lets a tab bar pop it, and the link a click on a screen below follows.
 *
 * @module
 */

import { useContext, useEffect, useReducer, useState } from "../runtime/hooks.ts";
import { navigationContexts, type StackNavigatorApi, type TabScope } from "./context.ts";
import type { ScreenOptions } from "./types.ts";

/** A stack owner's per-render state. */
export interface StackOwnerState {
  /** The tab the stack sits in, if any. */
  readonly tab: TabScope | null;
  /** Re-render the owner. */
  readonly force: () => void;
  /** The options `setOptions` set, by screen id. */
  readonly overrides: ReadonlyMap<string, ScreenOptions>;
  /** Update the overrides. */
  readonly setOverrides: (
    fn: (prev: ReadonlyMap<string, ScreenOptions>) => ReadonlyMap<string, ScreenOptions>,
  ) => void;
}

/** The owner's tab, re-render trigger and `setOptions` overrides. */
export function useStackOwner(): StackOwnerState {
  const tab = useContext(navigationContexts().tab);
  const [, force] = useReducer((n: number, _tick: void) => n + 1, 0);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ScreenOptions>>(() => new Map());
  return { tab, force, overrides, setOverrides };
}

/** What an owner does for its navigator. */
export interface StackOwnerOps {
  /** Navigate to `href`, pushing a screen or replacing the top one. */
  go(href: string, kind: "push" | "replace"): void;
  /** Pop so the screen at `index` is on top. */
  popTo(index: number): void;
  /** How many screens the stack holds. */
  depth(): number;
  /** The current `setOverrides`. */
  setOverrides(): StackOwnerState["setOverrides"];
}

/** The navigator the screens get through context (`useStackNavigation`). */
export function stackNavigator(ops: StackOwnerOps): StackNavigatorApi {
  return {
    push: (href) => ops.go(href, "push"),
    replace: (href) => ops.go(href, "replace"),
    popTo: (index) => ops.popTo(index),
    depth: () => ops.depth(),
    setOptions(id, options) {
      ops.setOverrides()((prev) => new Map(prev).set(id, { ...prev.get(id), ...options }));
    },
  };
}

/** Inside a tab: re-tapping the tab pops the stack to its root, then scrolls it to the top. */
export function useStackInTab(
  tab: TabScope | null,
  depth: () => number,
  popToTop: () => void,
  scrollToTop: () => boolean,
): void {
  useEffect(() => {
    if (!tab) return;
    return tab.register({ canGoBack: () => depth() > 1, popToTop, scrollToTop });
  }, [tab]);
}

/** Whether a click is a plain primary click (not a new-tab / context gesture). */
export function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The link a plain click (primary button, no modifier, same tab, not a download) follows, as
 * `toHref` turns the anchor into an app href; `null` for any other click.
 */
export function plainLinkHref(
  event: MouseEvent,
  toHref: (anchor: HTMLAnchorElement) => string,
): string | null {
  if (event.defaultPrevented || !plainClick(event)) return null;
  const anchor = (event.target as Element | null)?.closest?.("a");
  if (!anchor || anchor.hasAttribute("download")) return null;
  const target = anchor.getAttribute("target");
  if (target && target !== "_self") return null;
  return toHref(anchor as HTMLAnchorElement) || null;
}
