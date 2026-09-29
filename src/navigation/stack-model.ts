/**
 * The App Router stack's state as plain data, so every transition is a pure function a test
 * can drive: which screens the stack holds (bottom first), what a new route's content does
 * to it (push, pop back to it, replace, or refresh the top), the `maxDepth` unloading, the
 * deep-link ancestors, and the stamp each history entry carries so a reload rebuilds the
 * stack.
 *
 * @module
 */

import type { VNodeChildren } from "../jsx/types.ts";
import type { ScreenOptions } from "./types.ts";

/** One screen of the stack. */
export interface StackModelEntry {
  /** Unique per push (the React key of its screen). */
  readonly id: string;
  /** The route key (by default the pathname) that identifies "the same screen". */
  readonly key: string;
  /** The app-relative href it was shown at (pathname + search). */
  readonly href: string;
  /** Its content; `undefined` until loaded (a deep-link ancestor) or once unloaded. */
  readonly element: VNodeChildren | undefined;
  /** The options its page exported (`screenOptions`). */
  readonly options: ScreenOptions;
  /** `document.title` while it was on top, restored when it is popped back to. */
  readonly title?: string;
  /** The page's hydration data (the `#__denext_data` island's text), restored likewise. */
  readonly data?: string;
}

/** The stack: its screens, bottom first, and the counter behind fresh ids. */
export interface StackModel {
  readonly entries: readonly StackModelEntry[];
  readonly seq: number;
}

/** A route's content as it arrives with a navigation. */
export interface RouteContent {
  readonly key: string;
  readonly href: string;
  readonly element: VNodeChildren;
  readonly options: ScreenOptions;
  readonly title?: string;
  readonly data?: string;
}

/**
 * How the stack should take a route: `"auto"` pops back to the route when it is already below
 * the top and pushes it otherwise; `"push"` always pushes a new screen; `"replace"` swaps the
 * top screen for it.
 */
export type RouteIntent = "auto" | "push" | "replace";

/** What {@linkcode applyRoute} did. */
export type StackChange = "push" | "pop" | "replace" | "update";

/** The history-state key of the stacks' stamps (a map keyed by each stack's base path). */
export const STAMP_KEY = "__dnxStack";

/** What each history entry records about the stack it was on, so a reload can rebuild it. */
export interface StackStamp {
  /** The stack's base path (one stamp per stack; nested stacks keep their own). */
  readonly base: string;
  /** This entry's position in the stack. */
  readonly index: number;
  /** The stack's screens as of this entry, bottom first. */
  readonly entries: ReadonlyArray<
    { readonly id: string; readonly key: string; readonly href: string }
  >;
}

/** The default route key: the pathname without a trailing slash (the root stays `/`). */
export function routeKey(href: string): string {
  const path = href.split(/[?#]/, 1)[0] || "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** `base` as a path prefix: leading slash, no trailing slash (the root is `/`). */
export function normalizeBase(base: string | undefined): string {
  if (!base) return "/";
  const withLead = base.startsWith("/") ? base : "/" + base;
  return withLead.length > 1 && withLead.endsWith("/") ? withLead.slice(0, -1) : withLead;
}

/** Whether `pathname` is `base` or below it. */
export function underBase(pathname: string, base: string): boolean {
  if (base === "/") return pathname.startsWith("/");
  return pathname === base || pathname.startsWith(base + "/");
}

/**
 * The deep-link ancestors of `pathname` under `base`: every path from `base` down to (not
 * including) `pathname`, outermost first. `/items/42/comments` under `/items` gives
 * `["/items", "/items/42"]`; the base itself gives none.
 */
export function ancestorHrefs(pathname: string, base: string): string[] {
  const path = routeKey(pathname);
  const root = normalizeBase(base);
  if (!underBase(path, root) || path === root) return [];
  const rest = path.slice(root === "/" ? 1 : root.length + 1).split("/").filter(Boolean);
  const out = [root];
  let acc = root === "/" ? "" : root;
  for (let i = 0; i < rest.length - 1; i++) {
    acc += "/" + rest[i];
    out.push(acc);
  }
  return out;
}

/**
 * A stack with `route` on top of `ancestors` (deep-link placeholders: they load when popped
 * back to). Ids are deterministic (`a0`…, then `s0`) so a server render and the client's first
 * render agree.
 */
export function initialStack(route: RouteContent, ancestors: readonly string[] = []): StackModel {
  const below: StackModelEntry[] = ancestors.map((href, i) => ({
    id: `a${i}`,
    key: routeKey(href),
    href,
    element: undefined,
    options: {},
  }));
  return { entries: [...below, { ...route, id: "s0" }], seq: 1 };
}

/** The index of the highest screen below the top whose key is `key`, or -1. */
export function indexBelowTop(model: StackModel, key: string): number {
  for (let i = model.entries.length - 2; i >= 0; i--) {
    if (model.entries[i].key === key) return i;
  }
  return -1;
}

/** Unload (keep the entry, drop the content of) every screen deeper than `maxDepth` from the top. */
export function evict(
  entries: readonly StackModelEntry[],
  maxDepth: number,
): StackModelEntry[] {
  const keep = Math.max(1, Math.floor(maxDepth));
  const cut = entries.length - keep;
  return entries.map((
    e,
    i,
  ) => (i < cut && e.element !== undefined ? { ...e, element: undefined } : e));
}

/** The stack popped back so `index` is the top. */
export function popToIndex(model: StackModel, index: number): StackModel {
  if (index < 0 || index >= model.entries.length - 1) return model;
  return { entries: model.entries.slice(0, index + 1), seq: model.seq };
}

/** `route` merged into `entry` (same id: the screen keeps its state). */
function refresh(entry: StackModelEntry, route: RouteContent): StackModelEntry {
  return {
    ...entry,
    key: route.key,
    href: route.href,
    element: route.element,
    options: route.options,
    title: route.title ?? entry.title,
    data: route.data ?? entry.data,
  };
}

/**
 * What a route's content does to the stack (see {@linkcode RouteIntent}); screens deeper than
 * `maxDepth` are unloaded afterwards.
 */
export function applyRoute(
  model: StackModel,
  route: RouteContent,
  intent: RouteIntent = "auto",
  maxDepth = Infinity,
): { model: StackModel; change: StackChange } {
  const entries = model.entries;
  const top = entries[entries.length - 1];
  let next: StackModelEntry[];
  let seq = model.seq;
  let change: StackChange;
  if (top && top.key === route.key && intent !== "push") {
    next = [...entries.slice(0, -1), refresh(top, route)];
    change = "update";
  } else if (top && intent === "replace") {
    next = [...entries.slice(0, -1), { ...route, id: `s${seq++}` }];
    change = "replace";
  } else {
    const below = intent === "auto" ? indexBelowTop(model, route.key) : -1;
    if (below >= 0) {
      next = [...entries.slice(0, below), refresh(entries[below], route)];
      change = "pop";
    } else {
      next = [...entries, { ...route, id: `s${seq++}` }];
      change = "push";
    }
  }
  return { model: { entries: evict(next, maxDepth), seq }, change };
}

/** The stamp to record on the history entry showing the top of `model`. */
export function stampOf(model: StackModel, base: string): StackStamp {
  return {
    base,
    index: model.entries.length - 1,
    entries: model.entries.map(({ id, key, href }) => ({ id, key, href })),
  };
}

/** The stamp in a history `state` for the stack at `base`, if it holds a well-formed one. */
export function readStamp(state: unknown, base: string): StackStamp | null {
  if (typeof state !== "object" || state === null) return null;
  const stamps = (state as Record<string, unknown>)[STAMP_KEY];
  if (typeof stamps !== "object" || stamps === null) return null;
  const stamp = Object.hasOwn(stamps, base) ? (stamps as Record<string, unknown>)[base] : null;
  if (typeof stamp !== "object" || stamp === null) return null;
  const s = stamp as Partial<StackStamp>;
  if (s.base !== base || typeof s.index !== "number" || !Array.isArray(s.entries)) return null;
  const valid = s.entries.every((e) =>
    typeof e === "object" && e !== null && typeof e.id === "string" &&
    typeof e.key === "string" && typeof e.href === "string"
  );
  if (!valid || s.index < 0 || s.index >= s.entries.length) return null;
  return s as StackStamp;
}

/**
 * Rebuild a stack from a history stamp (after a reload, or on history the stack did not see):
 * the stamped screens below the stamp's index become placeholders (they load when popped back
 * to) under the current `top`, which keeps its id so its screen is not remounted.
 */
export function modelFromStamp(stamp: StackStamp, top: StackModelEntry, seq: number): StackModel {
  const below: StackModelEntry[] = stamp.entries.slice(0, stamp.index).map((e, i) => ({
    id: `p${i}`,
    key: e.key,
    href: e.href,
    element: undefined,
    options: {},
  }));
  return { entries: [...below, top], seq };
}

/**
 * History `state` with `stamp` recorded under {@linkcode STAMP_KEY} (a map by base path, so
 * nested stacks keep their own), keeping every other key.
 */
export function withStamp(state: unknown, stamp: StackStamp): Record<string, unknown> {
  const own = typeof state === "object" && state !== null ? state as Record<string, unknown> : {};
  const prior = own[STAMP_KEY];
  const stamps = typeof prior === "object" && prior !== null ? prior : {};
  return { ...own, [STAMP_KEY]: { ...stamps, [stamp.base]: stamp } };
}
