/**
 * The contexts that tie `denext/navigation` together: the screen a component renders in, the
 * stack navigator that screen belongs to, and the tab a stack lives in (so re-tapping the
 * tab pops that stack to its root). Created lazily: importing this module runs nothing.
 *
 * @module
 */

import { createContext } from "../runtime/context.ts";
import type { Context } from "../runtime/hooks.ts";
import type { ScreenOptions } from "./types.ts";

/** The screen a component renders in. */
interface ScreenInfo {
  /** The screen's unique id in its stack. */
  readonly id: string;
  /** Its position (0 = the root screen). */
  readonly index: number;
}

/** What a stack navigator offers its screens (the owner of a `StackView` provides it). */
export interface StackNavigatorApi {
  /** Push `href` as a new screen. */
  push(href: string): void;
  /** Replace the top screen with `href`. */
  replace(href: string): void;
  /** Pop so the screen at `index` is on top. */
  popTo(index: number): void;
  /** How many screens the stack holds. */
  depth(): number;
  /** Merge `options` into the options of the screen `id`. */
  setOptions(id: string, options: ScreenOptions): void;
}

/** What a stack inside a tab registers, so the tab bar can pop it or scroll it to the top. */
export interface TabStackHandle {
  /** Whether the stack has screens above its root. */
  canGoBack(): boolean;
  /** Pop to the root screen. */
  popToTop(): void;
  /** Scroll the top screen to its top; `false` when there was nothing to scroll. */
  scrollToTop(): boolean;
}

/** A tab's registry of the stacks rendered inside it. */
export interface TabScope {
  /** Register a stack; returns its unregister. */
  register(handle: TabStackHandle): () => void;
}

/** The three contexts, created on first use. */
interface NavigationContexts {
  readonly screen: Context<ScreenInfo | null>;
  readonly navigator: Context<StackNavigatorApi | null>;
  readonly tab: Context<TabScope | null>;
}

let contexts: NavigationContexts | null = null;

/** The navigation contexts (created once, on first call). */
export function navigationContexts(): NavigationContexts {
  return contexts ??= {
    screen: createContext<ScreenInfo | null>(null),
    navigator: createContext<StackNavigatorApi | null>(null),
    tab: createContext<TabScope | null>(null),
  };
}
