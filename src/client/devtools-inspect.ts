// First-party denext DevTools — the inspector bridge (dev-only).
//
// A native read/edit view over the LIVE reconciler: it walks the committed fiber
// tree, exposes each component's props plus its hooks/state/context with per-hook
// labels, and edits state live through the hook's own stable setter. It is distinct
// from the React-DevTools extension bridge in `./devtools.ts` (which reports a
// React-shaped tree to the browser extension) — this one powers denext's own in-page
// panel and the `denext/devtools` API, and surfaces things the extension can't (an
// RSC render-mode view derived from the island timeline).
//
// Dev-only and DCE-friendly: only the dev route/Flight entries import the installer
// (see `installDevtools` in `./devtools-panel.ts`), so production bundles never pull
// it in. Every entry point additionally no-ops unless `globalThis.__denextDev` is
// set. Nothing here runs on the render/commit hot path — the tree is serialized
// lazily on request, and the only per-commit cost is the single observer notify the
// reconciler already guards.

import type { Fiber, HookCell } from "./fiber/fiber.ts";
import {
  clearFiberProps,
  devRootFibers,
  fiberPropOverrides,
  overrideFiberProp,
  setCommitObserver,
  setDevIdForFiber,
  setRenderProfiler,
} from "./fiber/reconciler.ts";
import { setInspectorBridge } from "./devtools.ts";
import { familyIdOf } from "./refresh-runtime.ts";
import {
  brandOf,
  componentDisplayName,
  REACT_FORWARD_REF_TYPE,
  REACT_MEMO_TYPE,
} from "../runtime/react-brands.ts";
import { PROVIDER } from "../runtime/context.ts";
import { getIslandTimeline, type IslandHydration } from "./lazy-hydrate.ts";

// Hook-kind labels — mirror the `HK_*` constants in `fiber/reconciler.ts` (kept in
// sync by value). Only `state` cells are live-editable: a `state` setter accepts the
// next value directly, whereas a `reducer`'s dispatch expects an action, not a value.
const HOOK_KIND_LABELS: Record<number, string> = {
  1: "state", // HK_STATE
  2: "reducer", // HK_REDUCER
  3: "effect", // HK_EFFECT
  // HK_MEMO backs both useMemo and useCallback (a memoized function). We can't tell
  // them apart from the cell, so both read as `memo` — the value preview (`ƒ …` vs a
  // data value) is what distinguishes a useCallback cell in the panel.
  4: "memo", // HK_MEMO
  5: "ref", // HK_REF
  6: "id", // HK_ID
  7: "store", // HK_STORE
  8: "memoCache", // HK_MEMOCACHE
  9: "deferred", // HK_DEFERRED
  10: "layout", // HK_LAYOUT
  11: "insertion", // HK_INSERTION
};
const STATE_KIND = 1; // HK_STATE
const REDUCER_KIND = 2; // HK_REDUCER
const REF_KIND = 5; // HK_REF

function isDev(): boolean {
  try {
    return (globalThis as { __denextDev?: boolean }).__denextDev === true;
  } catch {
    return false;
  }
}

// ---- Value serialization ---------------------------------------------------

/** A display-safe rendering of a runtime value for the inspector. */
export interface SerializedValue {
  /** A short human preview, e.g. `42`, `"hi"`, `{a, b}`, `Array(3)`, `ƒ onClick`. */
  preview: string;
  /** A coarse type tag the panel uses to pick an editor / style. */
  type:
    | "string"
    | "number"
    | "boolean"
    | "null"
    | "undefined"
    | "bigint"
    | "symbol"
    | "function"
    | "array"
    | "object";
  /** For a primitive only: its raw value, so the panel can seed an editor. */
  raw?: string | number | boolean | null;
  /**
   * For an object/array only: its number of enumerable entries — the panel shows an
   * expander (and can lazily fetch one level via {@link getValueAt}) when `size > 0`.
   */
  size?: number;
  /**
   * One level of child entries — populated ONLY by a deep read ({@link getValueAt}),
   * never by the shallow tree/preview serializer, so the tree stays cheap. Each entry's
   * value is itself a shallow preview the panel can drill into with a longer `path`.
   */
  entries?: Array<{ key: string; value: SerializedValue }>;
}

/** Cap on how many child entries a single deep read expands (avoids huge arrays). */
const MAX_ENTRIES = 100;

const MAX_STRING = 80;

function truncate(s: string): string {
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "…" : s;
}

/** One-level, cycle-safe serialization — enough for a preview, never the hot path. */
function serializeValue(v: unknown, seen: WeakSet<object> = new WeakSet()): SerializedValue {
  if (v === null) return { preview: "null", type: "null", raw: null };
  const t = typeof v;
  if (t === "string") {
    return { preview: JSON.stringify(truncate(v as string)), type: "string", raw: v as string };
  }
  if (t === "number") return { preview: String(v), type: "number", raw: v as number };
  if (t === "boolean") return { preview: String(v), type: "boolean", raw: v as boolean };
  if (t === "undefined") return { preview: "undefined", type: "undefined" };
  if (t === "bigint") return { preview: `${v}n`, type: "bigint" };
  if (t === "symbol") return { preview: String(v), type: "symbol" };
  if (t === "function") {
    const name = (v as { name?: string }).name;
    return { preview: `ƒ ${name || "anonymous"}`, type: "function" };
  }
  // Objects & arrays: a shallow preview only.
  const obj = v as object;
  if (seen.has(obj)) return { preview: "[Circular]", type: "object" };
  seen.add(obj);
  if (Array.isArray(v)) return { preview: `Array(${v.length})`, type: "array", size: v.length };
  let keys: string[] = [];
  try {
    keys = Object.keys(obj);
  } catch {
    // Exotic object with a throwing key enumerator — fall back to a bare preview.
  }
  const shown = keys.slice(0, 4).join(", ");
  const more = keys.length > 4 ? ", …" : "";
  return { preview: `{${shown}${more}}`, type: "object", size: keys.length };
}

/**
 * A one-level-deep serialization: a preview of `v` plus, for an object/array, its
 * immediate child entries (each a shallow preview). Used by {@link getValueAt} to power
 * lazy click-to-expand — the tree walk keeps using the shallow {@link serializeValue}.
 */
function serializeValueDeep(v: unknown): SerializedValue {
  const sv = serializeValue(v);
  if (v === null || typeof v !== "object") return sv;
  const entries: Array<{ key: string; value: SerializedValue }> = [];
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length && i < MAX_ENTRIES; i++) {
      entries.push({ key: String(i), value: serializeValue(v[i]) });
    }
  } else {
    let keys: string[] = [];
    try {
      keys = Object.keys(v as object);
    } catch {
      // Exotic object — no expandable entries.
    }
    for (let i = 0; i < keys.length && i < MAX_ENTRIES; i++) {
      entries.push({
        key: keys[i],
        value: serializeValue((v as Record<string, unknown>)[keys[i]]),
      });
    }
  }
  sv.entries = entries;
  return sv;
}

// ---- Inspector tree --------------------------------------------------------

/** One hook cell as shown in the inspector. */
export interface InspectHook {
  /** Its index in the component's hook list (the key for {@link setHookState}). */
  index: number;
  /** A label from the hook kind (`state`, `effect`, `ref`, …), or `hook`. */
  kind: string;
  /** The cell's current value (state for state/reducer, `{current}` for a ref, …). */
  value: SerializedValue;
  /** Whether the panel may edit it live — `state` cells holding a primitive only. */
  editable: boolean;
  /** The hook's dependency array, when it has one (effect/memo/callback/deferred). */
  deps?: SerializedValue[];
  /** Whether an effect cell currently holds a cleanup function (effect/layout). */
  hasCleanup?: boolean;
}

/** One prop entry — for per-prop display and live override. */
export interface InspectProp {
  /** The prop name. */
  key: string;
  /** Its serialized value. */
  value: SerializedValue;
  /** Whether the panel may override it live (primitive values only). */
  editable: boolean;
}

/** One context this component read during its last render. */
export interface InspectContext {
  /** The context's symbol description, or `Context`. */
  name: string;
  /** The value visible to this component. */
  value: SerializedValue;
}

/** A component/host node in the inspector tree. */
export interface InspectNode {
  /** A stable id across re-renders (both fiber buffers map to it). */
  id: number;
  /** Display name — component name, host tag, `Fragment`, `Suspense`, … */
  name: string;
  /** The node's role in the tree. */
  kind: "component" | "host" | "text" | "fragment";
  /** The React key, if any. */
  key: string | null;
  /**
   * Zero or more capability/role badges the panel shows next to the name —
   * `memo`, `forwardRef`, `StrictMode`, `Suspense`(+`fallback`),
   * `ErrorBoundary`(+`errored`), `Context.Provider`. Absent when none apply.
   */
  badges?: string[];
  /** The node's props (shallow preview). */
  props: SerializedValue;
  /** Per-prop entries for a component (each live-overridable when primitive). */
  propEntries?: InspectProp[];
  /** Component hooks, in call order (empty for host/text/fragment). */
  hooks: InspectHook[];
  /** Contexts read this render (empty when none). */
  contexts: InspectContext[];
  /**
   * Source location (`fileUrl#Export`) from the Fast Refresh family registry, when
   * known — powers the panel's source link. Absent for host/fragment/text nodes and
   * components that weren't registered (e.g. in a production-shaped bundle).
   */
  source?: string;
  /** Child nodes, in order. */
  children: InspectNode[];
}

/** A component's source `fileUrl#Export` (cache-buster stripped), or undefined. */
function sourceOf(type: unknown): string | undefined {
  const fam = familyIdOf(type);
  if (!fam) return undefined;
  const hash = fam.lastIndexOf("#");
  const url = (hash >= 0 ? fam.slice(0, hash) : fam).replace(/\?[^#]*$/, "");
  const exp = hash >= 0 ? fam.slice(hash + 1) : "";
  return exp ? `${url}#${exp}` : url;
}

let idCounter = 0;
const fiberToId = new WeakMap<Fiber, number>();
// Rebuilt on every {@link getInspectorTree}; resolves an id back to a live fiber for
// {@link setHookState}. A fiber and its `alternate` share one id; both buffers share
// the same `hooks` array (and the same `HookCell` objects), so editing through either
// targets the live state.
let idToFiber = new Map<number, Fiber>();

function idFor(fiber: Fiber): number {
  let id = fiberToId.get(fiber);
  if (id === undefined && fiber.alternate) id = fiberToId.get(fiber.alternate);
  if (id === undefined) id = ++idCounter;
  fiberToId.set(fiber, id);
  if (fiber.alternate) fiberToId.set(fiber.alternate, id);
  return id;
}

function serializeHooks(fiber: Fiber): InspectHook[] {
  const cells = fiber.hooks;
  if (!cells || cells.length === 0) return [];
  const out: InspectHook[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const kind = cell.kind ?? 0;
    const value = serializeValue(cell.value);
    const editable = kind === STATE_KIND && typeof cell.updater === "function" &&
      (value.type === "string" || value.type === "number" || value.type === "boolean" ||
        value.type === "null");
    const hook: InspectHook = {
      index: i,
      kind: HOOK_KIND_LABELS[kind] ?? "hook",
      value,
      editable,
    };
    if (Array.isArray(cell.deps)) hook.deps = cell.deps.map((d) => serializeValue(d));
    if (kind === 3 || kind === 10) hook.hasCleanup = typeof cell.cleanup === "function";
    out.push(hook);
  }
  return out;
}

/**
 * Per-prop entries for a component (children shown via the tree, so skipped). Any
 * live prop override is merged over the real props so the panel shows (and re-edits)
 * the effective value.
 */
function serializeProps(fiber: Fiber): InspectProp[] {
  const base = fiber.vnode.props;
  if (base == null || typeof base !== "object") return [];
  const ov = fiberPropOverrides(fiber);
  const props = ov ? { ...(base as Record<string, unknown>), ...ov } : base;
  const out: InspectProp[] = [];
  for (const [key, v] of Object.entries(props as Record<string, unknown>)) {
    if (key === "children" || key === "ref") continue;
    const value = serializeValue(v);
    const editable = value.type === "string" || value.type === "number" ||
      value.type === "boolean";
    out.push({ key, value, editable });
  }
  return out;
}

function serializeContexts(fiber: Fiber): InspectContext[] {
  const read = fiber.readContexts;
  if (!read || read.size === 0) return [];
  const out: InspectContext[] = [];
  for (const sym of read) {
    out.push({
      name: contextName(sym),
      value: serializeValue(fiber.inherited.get(sym)),
    });
  }
  return out;
}

/** Capability/role badges for a fiber, or undefined when none apply. */
function badgesOf(fiber: Fiber): string[] | undefined {
  const badges = BADGES_BY_TAG[fiber.tag]?.(fiber) ?? [];
  return badges.length > 0 ? badges : undefined;
}

/** Per fiber tag: the capability/role badges (memo/forwardRef/StrictMode, Suspense state, …). */
const BADGES_BY_TAG: Partial<Record<Fiber["tag"], (fiber: Fiber) => string[]>> = {
  component: (fiber) => {
    const badges: string[] = [];
    const brand = brandOf(fiber.vnode.type);
    if (brand === REACT_MEMO_TYPE) badges.push("memo");
    else if (brand === REACT_FORWARD_REF_TYPE) badges.push("forwardRef");
    if (fiber.strict === true) badges.push("StrictMode");
    return badges;
  },
  suspense: (fiber) => fiber.showingFallback === true ? ["Suspense", "fallback"] : ["Suspense"],
  errorboundary: (fiber) =>
    fiber.__error != null ? ["ErrorBoundary", "errored"] : ["ErrorBoundary"],
  fragment: (fiber) => {
    const props = fiber.vnode.props as Record<string | symbol, unknown> | null | undefined;
    return props && props[PROVIDER as unknown as string] !== undefined ? ["Context.Provider"] : [];
  },
};

// DOM → fiber map, rebuilt on each {@link getInspectorTree} walk (alongside `idToFiber`).
// Maps every host/text `stateNode` to its owning fiber so the panel's element picker and
// hover-highlight can resolve a DOM node back to a component (see {@link getFiberIdForDom}).
let domToFiber = new WeakMap<Node, Fiber>();

function buildNode(fiber: Fiber, idMap: Map<number, Fiber>): InspectNode {
  const id = idFor(fiber);
  idMap.set(id, fiber);
  if (fiber.stateNode) domToFiber.set(fiber.stateNode as unknown as Node, fiber);
  const key = fiber.vnode.key == null ? null : String(fiber.vnode.key);
  const props = serializeValue(fiber.vnode.props);
  const propEntries = fiber.tag === "component" ? serializeProps(fiber) : undefined;
  const badges = badgesOf(fiber);
  const children: InspectNode[] = [];
  for (let c = fiber.child; c !== null; c = c.sibling) children.push(buildNode(c, idMap));

  switch (fiber.tag) {
    case "text":
      return {
        id,
        name: "text",
        kind: "text",
        key: null,
        props: serializeValue(
          String((fiber.vnode.props as { nodeValue?: unknown })?.nodeValue ?? ""),
        ),
        hooks: [],
        contexts: [],
        children,
      };
    case "component":
      return {
        id,
        name: componentDisplayName(fiber.vnode.type),
        kind: "component",
        key,
        badges,
        props,
        propEntries,
        hooks: serializeHooks(fiber),
        contexts: serializeContexts(fiber),
        source: sourceOf(fiber.vnode.type),
        children,
      };
    case "suspense":
    case "errorboundary":
      return {
        id,
        name: fiber.tag === "suspense" ? "Suspense" : "ErrorBoundary",
        kind: "component",
        key,
        badges,
        props,
        hooks: [],
        contexts: [],
        children,
      };
    case "fragment":
      return {
        id,
        name: badges?.includes("Context.Provider") ? "Context.Provider" : "Fragment",
        kind: "fragment",
        key,
        badges,
        props,
        hooks: [],
        contexts: [],
        children,
      };
    case "portal":
      return {
        id,
        name: "Portal",
        kind: "fragment",
        key,
        props,
        hooks: [],
        contexts: [],
        children,
      };
    default:
      return {
        id,
        name: typeof fiber.vnode.type === "string" ? fiber.vnode.type : "host",
        kind: "host",
        key,
        props,
        hooks: [],
        contexts: [],
        children,
      };
  }
}

/**
 * The current component tree — every mounted root's children, each node carrying its
 * props, hooks/state, and contexts. Serialized on demand (never per commit). Empty in
 * production or before the first mount.
 */
export function getInspectorTree(): InspectNode[] {
  if (!isDev()) return [];
  const fresh = new Map<number, Fiber>();
  domToFiber = new WeakMap<Node, Fiber>();
  const out: InspectNode[] = [];
  for (const root of devRootFibers()) {
    for (let c = root.child; c !== null; c = c.sibling) out.push(buildNode(c, fresh));
  }
  idToFiber = fresh;
  return out;
}

/**
 * Set a `useState` cell's value live, driving the component's own setter (the normal
 * setState path, so it schedules a re-render exactly as the app would). `fiberId` and
 * `hookIndex` come from an {@link InspectNode}/{@link InspectHook} of the most recent
 * {@link getInspectorTree}. Returns whether the cell was found and updatable.
 */
export function setHookState(fiberId: number, hookIndex: number, value: unknown): boolean {
  if (!isDev()) return false;
  const fiber = idToFiber.get(fiberId);
  const cell: HookCell | undefined = fiber?.hooks?.[hookIndex];
  if (!cell || typeof cell.updater !== "function") return false;
  cell.updater(value);
  return true;
}

/**
 * Dispatch an action to a `useReducer` cell live, driving the component's own dispatch
 * (so the reducer runs and a re-render schedules exactly as the app would). Distinct
 * from {@link setHookState}: a reducer's updater expects an *action*, not the next value.
 * Returns whether the cell was found and is a reducer.
 */
export function dispatchReducer(fiberId: number, hookIndex: number, action: unknown): boolean {
  if (!isDev()) return false;
  const cell: HookCell | undefined = idToFiber.get(fiberId)?.hooks?.[hookIndex];
  if (!cell || cell.kind !== REDUCER_KIND || typeof cell.updater !== "function") return false;
  cell.updater(action);
  return true;
}

/**
 * Set a `useRef` cell's `.current` live. A ref write does not itself schedule a render
 * (matching React), so the change is visible on the next commit the app makes; the panel
 * updates its own view optimistically. Returns whether the cell was found and is a ref.
 */
export function setRefValue(fiberId: number, hookIndex: number, value: unknown): boolean {
  if (!isDev()) return false;
  const cell: HookCell | undefined = idToFiber.get(fiberId)?.hooks?.[hookIndex];
  if (!cell || cell.kind !== REF_KIND) return false;
  const ref = cell.value;
  if (ref == null || typeof ref !== "object") return false;
  (ref as { current: unknown }).current = value;
  return true;
}

/** A reference to one drill-in root on a component: a prop, a hook cell, or a context. */
export type ValueRef =
  | { kind: "prop"; key: string }
  | { kind: "hook"; index: number }
  | { kind: "context"; key: string };

/** Resolve a {@link ValueRef} to its live root value off `fiber`, or `undefined`. */
function rootValueForRef(fiber: Fiber, ref: ValueRef): unknown {
  switch (ref.kind) {
    case "prop":
      return livePropValue(fiber, ref.key);
    case "hook":
      return fiber.hooks?.[ref.index]?.value;
    case "context":
      return readContextValue(fiber, ref.key);
  }
}

/** A prop's live value (panel prop overrides applied). */
function livePropValue(fiber: Fiber, key: string): unknown {
  const base = fiber.vnode.props;
  if (base == null || typeof base !== "object") return undefined;
  const ov = fiberPropOverrides(fiber);
  const props = ov ? { ...(base as Record<string, unknown>), ...ov } : base;
  return (props as Record<string, unknown>)[key];
}

/** The value of the read context whose display name is `name`. */
/** A context's display name: its symbol description (`createContext` names them). */
function contextName(sym: symbol): string {
  return sym.description ?? "Context";
}

function readContextValue(fiber: Fiber, name: string): unknown {
  for (const sym of fiber.readContexts ?? []) {
    if (contextName(sym) === name) return fiber.inherited.get(sym);
  }
  return undefined;
}

/**
 * Read one level of a component's live value at `path` under `ref` — a prop, a hook
 * cell's value, or a read context — re-reading it fresh off the fiber and serializing it
 * a single level deep (with child `entries`). Powers the panel's on-demand, click-to-
 * expand nested-value view: expand a level by calling again with a longer `path`.
 * Returns `null` for an unknown fiber or a `path` that no longer resolves.
 */
export function getValueAt(fiberId: number, ref: ValueRef, path: Array<string | number>):
  | SerializedValue
  | null {
  if (!isDev()) return null;
  const live = liveValueAt(fiberId, ref, path);
  return live.found ? serializeValueDeep(live.value) : null;
}

/** Walk `ref`+`path` to the live value off the fiber (shared by the deep read + actions). */
function liveValueAt(
  fiberId: number,
  ref: ValueRef,
  path: Array<string | number>,
): { found: boolean; value: unknown } {
  const fiber = idToFiber.get(fiberId);
  if (!fiber) return { found: false, value: undefined };
  let value = rootValueForRef(fiber, ref);
  for (const step of path) {
    if (value == null || typeof value !== "object") return { found: false, value: undefined };
    value = (value as Record<string | number, unknown>)[step as never];
  }
  return { found: true, value };
}

/**
 * `console.log` the *live* value at `ref`+`path` (so the developer gets the real object
 * in the console, not the panel's serialized preview). Returns whether it resolved.
 */
export function logValueAt(fiberId: number, ref: ValueRef, path: Array<string | number>): boolean {
  if (!isDev()) return false;
  const { found, value } = liveValueAt(fiberId, ref, path);
  if (!found) return false;
  try {
    console.log("[denext]", value);
  } catch {
    // A console that throws must not surface as a panel error.
  }
  return true;
}

/**
 * Stash the live value at `ref`+`path` on `globalThis.$d` (React DevTools' `$r`-style
 * temporary), so it can be poked at from the console. Returns the global name, or `null`.
 */
export function storeAsGlobal(
  fiberId: number,
  ref: ValueRef,
  path: Array<string | number>,
): string | null {
  if (!isDev()) return null;
  const { found, value } = liveValueAt(fiberId, ref, path);
  if (!found) return null;
  try {
    (globalThis as Record<string, unknown>).$d = value;
    return "$d";
  } catch {
    return null;
  }
}

/**
 * The nearest component fiber id owning `el` — for the element picker and hover-
 * highlight. Walks `el` up to the nearest host node the last {@link getInspectorTree}
 * walk mapped, then up the fiber tree to its owning component (falling back to the host
 * fiber's own id when no component ancestor exists). `null` when nothing maps — call
 * {@link getInspectorTree} first so the DOM map is current.
 */
export function getFiberIdForDom(el: Node | null): number | null {
  if (!isDev()) return null;
  let node: Node | null = el;
  let host: Fiber | undefined;
  while (node && !(host = domToFiber.get(node))) {
    node = (node as { parentNode?: Node | null }).parentNode ?? null;
  }
  if (!host) return null;
  for (let f: Fiber | null = host; f !== null; f = f.return) {
    if (f.tag === "component") return idFor(f);
  }
  return idFor(host);
}

/**
 * The DOM element for a fiber id — its own host node when it is a host fiber, else the
 * first host node in its subtree (a component's rendered root). Backs the panel's
 * tree-row → element highlight. `null` for an unknown id or a fiber with no host DOM.
 */
export function getHostNode(fiberId: number): Element | null {
  if (!isDev()) return null;
  const fiber = idToFiber.get(fiberId);
  if (!fiber) return null;
  const found = firstHostElement(fiber);
  return found;
}

function firstHostElement(fiber: Fiber): Element | null {
  const sn = fiber.stateNode;
  if (sn && (sn as { nodeType?: number }).nodeType === 1) return sn as unknown as Element;
  for (let c = fiber.child; c !== null; c = c.sibling) {
    const hit = firstHostElement(c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Override a component's prop live — pin `key` to `value` and re-render it (the live
 * companion to {@link setHookState}). The override persists across the component's own
 * re-renders until {@link clearPropOverrides}. `fiberId` comes from the most recent
 * {@link getInspectorTree}. Returns whether the fiber was found.
 */
export function setPropOverride(fiberId: number, key: string, value: unknown): boolean {
  if (!isDev()) return false;
  const fiber = idToFiber.get(fiberId);
  if (!fiber) return false;
  overrideFiberProp(fiber, key, value);
  return true;
}

/** Drop all live prop overrides on a component and re-render it. */
export function clearPropOverrides(fiberId: number): boolean {
  if (!isDev()) return false;
  const fiber = idToFiber.get(fiberId);
  if (!fiber) return false;
  clearFiberProps(fiber);
  return true;
}

/**
 * The component ancestor chain for a node — the names of the component fibers above
 * it (nearest first), each with its source when known. An approximation of React's
 * "owner stack": the render-parent path rather than the JSX-owner, which coincide for
 * the common case. `fiberId` comes from the most recent {@link getInspectorTree}.
 * Empty in production or for an unknown/stale id.
 */
export function getOwnerStack(fiberId: number): Array<{ name: string; source?: string }> {
  if (!isDev()) return [];
  const fiber = idToFiber.get(fiberId);
  if (!fiber) return [];
  const stack: Array<{ name: string; source?: string }> = [];
  for (let f = fiber.return; f !== null; f = f.return) {
    if (f.tag === "component") {
      stack.push({ name: componentDisplayName(f.vnode.type), source: sourceOf(f.vnode.type) });
    }
  }
  return stack;
}

// ---- Profiler --------------------------------------------------------------

/** One component's aggregated render profile. */
export interface ProfileEntry {
  /** Component display name. */
  name: string;
  /** How many times it rendered while profiling. */
  count: number;
  /** Total render time across those renders (ms). */
  totalMs: number;
  /** The slowest single render (ms). */
  maxMs: number;
}

const profile = new Map<string, { count: number; totalMs: number; maxMs: number }>();
let profiling = false;

// ---- Per-commit flamegraph capture -----------------------------------------

/** One node in a commit's flamegraph — a component and the time under it. */
export interface FlameNode {
  /** The component's stable inspector id. */
  id: number;
  /** Display name. */
  name: string;
  /** This component's OWN render time this commit (0 if it didn't render). */
  selfMs: number;
  /** `selfMs` plus the total time of every descendant component. */
  totalMs: number;
  /** Whether this component actually rendered in this commit (vs. bailed/untouched). */
  didRender: boolean;
  /** Why it rendered (when render-reason tracking is on), else `null`. */
  changed: RenderReason | null;
  /** Descendant components (host/fragment levels are flattened through). */
  children: FlameNode[];
}

/** A recorded commit: its timing and a synthetic flamegraph root. */
export interface CommitSummary {
  /** 1-based commit number within the recording. */
  index: number;
  /** `performance.now()` at commit. */
  commitTime: number;
  /** Total component render time in this commit (ms). */
  duration: number;
  /** Whether this commit mounted any new component (else it's an update). */
  phase: "mount" | "update";
  /** How many components rendered. */
  renderCount: number;
}

interface CommitSample extends CommitSummary {
  root: FlameNode;
}

/** Most recent commits kept for step-through (a bounded ring buffer). */
const MAX_COMMITS = 200;
const commitSamples: CommitSample[] = [];
// Per-fiber timing for the CURRENT recording: the fiber's last self-render time, and the
// commit tick it last rendered in (so a commit walk can tell rendered vs. bailed).
const fiberSelfMs = new WeakMap<Fiber, number>();
const fiberRenderTick = new WeakMap<Fiber, number>();
let currentTick = 0;
// Ids seen across the recording, for the mount-vs-update phase classification.
const seenFiberIds = new Set<number>();

/**
 * Start recording per-component render timings (via the reconciler's dev-only profiler
 * seam) — both the name-aggregated {@link getProfile} and the per-commit flamegraph
 * ({@link getCommits}/{@link getCommitTree}). Clears any prior recording. No-op in
 * production or if already on.
 */
export function startProfiling(): void {
  if (!isDev() || profiling) return;
  profiling = true;
  profile.clear();
  commitSamples.length = 0;
  seenFiberIds.clear();
  currentTick = 1;
  ensureCommitObserver(); // so captureCommitSample runs even without a panel subscriber
  setRenderProfiler((type, ms, fiber) => {
    const name = componentDisplayName(type);
    const e = profile.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    e.count++;
    e.totalMs += ms;
    if (ms > e.maxMs) e.maxMs = ms;
    profile.set(name, e);
    // Stamp per-fiber timing for this commit's flamegraph (last write wins across a
    // render-phase update / StrictMode double-invoke — both are the same commit tick).
    fiberSelfMs.set(fiber, ms);
    fiberRenderTick.set(fiber, currentTick);
  });
}

/** Stop recording render timings (keeps the collected data for {@link getProfile}). */
export function stopProfiling(): void {
  if (!profiling) return;
  profiling = false;
  setRenderProfiler(null);
  maybeUninstallCommitObserver();
}

/** Whether the profiler is currently recording. */
export function isProfiling(): boolean {
  return profiling;
}

/** The collected profile, heaviest total render time first. Empty in production. */
export function getProfile(): ProfileEntry[] {
  if (!isDev()) return [];
  return [...profile.entries()]
    .map(([name, e]) => ({ name, count: e.count, totalMs: e.totalMs, maxMs: e.maxMs }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Discard the collected profile (aggregate + per-commit) without stopping recording. */
export function resetProfile(): void {
  profile.clear();
  commitSamples.length = 0;
  seenFiberIds.clear();
}

/** Build a flame node for a component fiber, descending through non-component levels. */
function buildFlame(fiber: Fiber, tick: number, flat: FlameNode[]): FlameNode {
  const id = idFor(fiber);
  const rendered = fiberRenderTick.get(fiber) === tick;
  const selfMs = rendered ? (fiberSelfMs.get(fiber) ?? 0) : 0;
  const children: FlameNode[] = [];
  for (let c = fiber.child; c !== null; c = c.sibling) collectFlameTops(c, tick, children, flat);
  let totalMs = selfMs;
  for (const c of children) totalMs += c.totalMs;
  const node: FlameNode = {
    id,
    name: componentDisplayName(fiber.vnode.type),
    selfMs,
    totalMs,
    didRender: rendered,
    changed: renderReasons.get(id) ?? null,
    children,
  };
  flat.push(node);
  return node;
}

/** Collect the top-level component descendants of `fiber` (flattening host/fragment). */
function collectFlameTops(fiber: Fiber, tick: number, out: FlameNode[], flat: FlameNode[]): void {
  if (fiber.tag === "component") {
    out.push(buildFlame(fiber, tick, flat));
  } else {
    for (let c = fiber.child; c !== null; c = c.sibling) collectFlameTops(c, tick, out, flat);
  }
}

/** Snapshot this commit's flamegraph into the ring buffer (called from {@link onCommit}). */
function captureCommitSample(): void {
  const tick = currentTick;
  const roots: FlameNode[] = [];
  const flat: FlameNode[] = [];
  for (const root of devRootFibers()) {
    for (let c = root.child; c !== null; c = c.sibling) collectFlameTops(c, tick, roots, flat);
  }
  let duration = 0;
  for (const n of roots) duration += n.totalMs;
  let renderCount = 0;
  let isMount = false;
  for (const n of flat) {
    if (n.didRender) {
      renderCount++;
      if (!seenFiberIds.has(n.id)) isMount = true;
    }
  }
  for (const n of flat) seenFiberIds.add(n.id);
  const commitTime = performance.now();
  const sample: CommitSample = {
    index: tick,
    commitTime,
    duration,
    phase: isMount ? "mount" : "update",
    renderCount,
    root: {
      id: -1,
      name: "(commit)",
      selfMs: 0,
      totalMs: duration,
      didRender: false,
      changed: null,
      children: roots,
    },
  };
  commitSamples.push(sample);
  if (commitSamples.length > MAX_COMMITS) commitSamples.shift();
  currentTick++;
}

/** The recorded commits (oldest first) — one summary per commit. Empty in production. */
export function getCommits(): CommitSummary[] {
  if (!isDev()) return [];
  return commitSamples.map(({ index, commitTime, duration, phase, renderCount }) => ({
    index,
    commitTime,
    duration,
    phase,
    renderCount,
  }));
}

/**
 * The flamegraph for a recorded commit — a synthetic `(commit)` root whose children are
 * the tree's top-level components, each carrying `selfMs`/`totalMs`/`didRender`/`changed`.
 * `index` is a {@link CommitSummary} index. `null` for an unknown index / in production.
 */
export function getCommitTree(index: number): FlameNode | null {
  if (!isDev()) return null;
  return commitSamples.find((s) => s.index === index)?.root ?? null;
}

// ---- "Why did this render?" ------------------------------------------------

/** Which of a component's inputs changed to cause its most recent render. */
export interface RenderReason {
  /** Prop keys whose value changed (by identity). */
  props: string[];
  /** Hook indices whose value or deps changed. */
  hooks: number[];
  /** Read-context names whose value changed. */
  contexts: string[];
  /**
   * How many times it has rendered while tracking — counting the initial mount plus
   * every later commit in which a prop/hook/context it depends on changed. (A re-render
   * driven purely by a non-memoized parent, with identical inputs, isn't counted — the
   * shared hook buffer leaves no per-fiber "did-run" signal for the inspector to read.)
   */
  count: number;
}

/** A per-commit snapshot of a component's inputs, diffed against the next commit. */
interface FiberSnapshot {
  props: Map<string, unknown>;
  hooks: unknown[];
  hookDeps: Array<unknown[] | undefined>;
  contexts: Map<symbol, unknown>;
}

let reasonsEnabled = false;
const renderReasons = new Map<number, RenderReason>();
const reasonSnapshots = new Map<number, FiberSnapshot>();

/** A component's effective props (overrides merged), minus `children`/`ref`. */
function mergedPropsMap(fiber: Fiber): Map<string, unknown> {
  const m = new Map<string, unknown>();
  const base = fiber.vnode.props;
  if (base != null && typeof base === "object") {
    const ov = fiberPropOverrides(fiber);
    const props = ov
      ? { ...(base as Record<string, unknown>), ...ov }
      : base as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) {
      if (k === "children" || k === "ref") continue;
      m.set(k, v);
    }
  }
  return m;
}

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function snapshotFiber(fiber: Fiber): FiberSnapshot {
  const cells = fiber.hooks ?? [];
  const contexts = new Map<symbol, unknown>();
  if (fiber.readContexts) {
    for (const sym of fiber.readContexts) contexts.set(sym, fiber.inherited.get(sym));
  }
  return {
    props: mergedPropsMap(fiber),
    // Copy value refs and deps arrays: both buffers share the live hook cells, so the
    // snapshot must capture this commit's values before the next render mutates them.
    hooks: cells.map((c) => c.value),
    hookDeps: cells.map((c) => (Array.isArray(c.deps) ? c.deps.slice() : undefined)),
    contexts,
  };
}

/** The keys whose values differ between two snapshots' maps. */
function changedKeys<K>(prev: Map<K, unknown>, next: Map<K, unknown>): K[] {
  const out: K[] = [];
  for (const k of new Set([...prev.keys(), ...next.keys()])) {
    if (!Object.is(prev.get(k), next.get(k))) out.push(k);
  }
  return out;
}

/** The hook cells whose value or deps changed between two snapshots. */
function changedHooks(prev: FiberSnapshot, next: FiberSnapshot): number[] {
  const hooks: number[] = [];
  const n = Math.max(prev.hooks.length, next.hooks.length);
  for (let i = 0; i < n; i++) {
    if (
      !Object.is(prev.hooks[i], next.hooks[i]) || !depsEqual(prev.hookDeps[i], next.hookDeps[i])
    ) {
      hooks.push(i);
    }
  }
  return hooks;
}

/** Diff this commit's snapshot of a component against the previous one and record why it rendered. */
function recordRenderReason(id: number, snap: FiberSnapshot): void {
  const prev = reasonSnapshots.get(id);
  reasonSnapshots.set(id, snap);
  if (!prev) {
    renderReasons.set(id, { props: [], hooks: [], contexts: [], count: 1 });
    return;
  }
  const props = changedKeys(prev.props, snap.props);
  const hooks = changedHooks(prev, snap);
  const contexts = changedKeys(prev.contexts, snap.contexts).map((sym) => contextName(sym));
  const changed = props.length > 0 || hooks.length > 0 || contexts.length > 0;
  const prevCount = renderReasons.get(id)?.count ?? 1;
  renderReasons.set(id, { props, hooks, contexts, count: prevCount + (changed ? 1 : 0) });
}

function walkReasons(fiber: Fiber, alive: Set<number>): void {
  if (fiber.tag === "component") {
    const id = idFor(fiber);
    alive.add(id);
    recordRenderReason(id, snapshotFiber(fiber));
  }
  for (let c = fiber.child; c !== null; c = c.sibling) walkReasons(c, alive);
}

/** Snapshot every component fiber this commit and diff it against the last (dev-only). */
function captureRenderReasons(): void {
  const alive = new Set<number>();
  for (const root of devRootFibers()) walkReasons(root, alive);
  for (const id of reasonSnapshots.keys()) {
    if (!alive.has(id)) {
      reasonSnapshots.delete(id);
      renderReasons.delete(id);
    }
  }
}

/**
 * Begin tracking why each component renders — install the commit hook and clear any
 * prior data. The panel enables this when its "why did this render" view is on; the
 * first commit after enabling seeds the baseline (so reasons appear from the next
 * render onward). No-op in production.
 */
export function enableRenderReasons(): void {
  if (!isDev() || reasonsEnabled) return;
  reasonsEnabled = true;
  renderReasons.clear();
  reasonSnapshots.clear();
  ensureCommitObserver();
  // Seed a baseline from whatever is already mounted, so the FIRST commit after enabling
  // is diffed as a real change (not swallowed as the initial snapshot).
  captureRenderReasons();
}

/** Stop tracking render reasons (and uninstall the commit hook if nothing else needs it). */
export function disableRenderReasons(): void {
  if (!reasonsEnabled) return;
  reasonsEnabled = false;
  maybeUninstallCommitObserver();
}

/**
 * The recorded {@link RenderReason} for a component — what changed to cause its most
 * recent render, and its render count — or `null` when tracking is off, the id is
 * unknown, or it hasn't rendered since {@link enableRenderReasons}.
 */
export function getRenderReason(fiberId: number): RenderReason | null {
  if (!isDev()) return null;
  return renderReasons.get(fiberId) ?? null;
}

// ---- Commit subscription ---------------------------------------------------

type Sub = () => void;
const subs = new Set<Sub>();
let commitObserverInstalled = false;

/** The single reconciler commit observer: capture render reasons, then notify subscribers. */
function onCommit(): void {
  if (reasonsEnabled) {
    try {
      captureRenderReasons();
    } catch {
      // Reason tracking must never break a commit.
    }
  }
  if (profiling) {
    try {
      // After render reasons, so each flame node can carry its "why did this render".
      captureCommitSample();
    } catch {
      // Profiler capture must never break a commit.
    }
  }
  for (const s of subs) {
    try {
      s();
    } catch {
      // A subscriber must never break a commit.
    }
  }
}

/** Install the shared reconciler commit observer (idempotent). */
function ensureCommitObserver(): void {
  if (commitObserverInstalled) return;
  commitObserverInstalled = true;
  setCommitObserver(onCommit);
}

/** Drop the shared observer once nothing (subscriber, reasons, or profiler) needs it. */
function maybeUninstallCommitObserver(): void {
  if (commitObserverInstalled && subs.size === 0 && !reasonsEnabled && !profiling) {
    commitObserverInstalled = false;
    setCommitObserver(null);
  }
}

/**
 * Subscribe to commits — `fn` fires (cheaply) after every commit so a panel can
 * lazily re-pull {@link getInspectorTree}. Returns an unsubscribe. No-op (returns a
 * no-op) in production. The reconciler observer is installed only while ≥1 subscriber
 * is active (or render-reason tracking is on).
 */
export function subscribe(fn: () => void): () => void {
  if (!isDev()) return () => {};
  subs.add(fn);
  ensureCommitObserver();
  return () => {
    subs.delete(fn);
    maybeUninstallCommitObserver();
  };
}

// ---- Render modes (v1: derived from the island timeline) -------------------

/** A component boundary's render mode, for the panel's glass-box view. */
export interface RenderModeEntry {
  /** The island's `data-dnx-id`, or a synthetic id. */
  id: string;
  /** The `client:*` strategy that hydrated it (islands only). */
  strategy?: string;
  /** Strategy parameter (the media query for `media`). */
  param?: string;
  /** How it reached the browser. v1 classifies client islands from the island
   * timeline; everything else the page rendered is server-produced HTML. */
  mode: "client-island";
  /** Milliseconds since page load when it hydrated (islands only). */
  hydratedAt?: number;
}

/**
 * The render-mode view. v1 reports the **client boundaries** — the islands, with their
 * hydration strategy and timing (the server-rendered remainder is static/streamed HTML
 * carrying no client boundary). A future revision adds server-emitted per-boundary
 * static/dynamic/streamed + cache detail. Empty in production.
 */
export function getRenderModes(): RenderModeEntry[] {
  if (!isDev()) return [];
  return getIslandTimeline().map((i: IslandHydration) => {
    const e: RenderModeEntry = {
      id: i.id ?? "island",
      strategy: i.strategy,
      mode: "client-island",
      hydratedAt: i.at,
    };
    if (i.param !== undefined) e.param = i.param;
    return e;
  });
}

// ---- Page render mode (server-emitted) -------------------------------------

/** The server-emitted page render mode (from the dev `#__denext_render_modes` island). */
export interface PageRenderMode {
  /** The route this page was rendered for. */
  route: string;
  /** How the document was produced: fully static, dynamic (read a request API), or streamed. */
  mode: "static" | "dynamic" | "streamed";
  /** This request's page-cache outcome, or `null` when not cache-served. */
  cache: "HIT" | "STALE" | "MISS" | null;
}

/**
 * The server's render-mode verdict for this page — static vs dynamic vs streamed, and
 * the page-cache outcome — read from the dev-only `#__denext_render_modes` JSON island
 * the document renderer emits. `null` in production, outside a dev render, or if absent.
 */
export function getPageRenderMode(): PageRenderMode | null {
  if (!isDev()) return null;
  try {
    const doc = (globalThis as { document?: Document }).document;
    const el = doc?.getElementById("__denext_render_modes");
    if (!el || !el.textContent) return null;
    return JSON.parse(el.textContent) as PageRenderMode;
  } catch {
    return null;
  }
}

/** One Suspense boundary's timeline: server resolve time and (live) client reveal time. */
export interface BoundaryTiming {
  /** The boundary id (`dnx<n>`). */
  id: string;
  /** How long it took to resolve on the server (ms). */
  ms: number;
  /**
   * When it was revealed on the client (ms since navigation start), from the swap
   * runtime's real-time marks — present as soon as the hole lands, before the stream's
   * end-of-stream timing island exists. Absent until the boundary has been revealed.
   */
  revealAt?: number;
}

/** One real-time reveal record the swap runtime pushes onto `window.__denextBoundaries`. */
interface RevealRecord {
  id: string;
  revealAt: number;
  serverMs: number | null;
}

/**
 * The per-Suspense-boundary timeline — a LIVE merge of two sources: the swap runtime's
 * real-time reveal marks (`window.__denextBoundaries`, populated as each hole lands, in
 * dev) and the end-of-stream `#__denext_boundary_timing` island (authoritative server
 * resolve times, present once the stream finishes). So the panel shows a boundary the
 * instant it reveals (client reveal + the template's `data-dnx-ms` server time), then
 * settles to the island's rounded server time. Empty in production / on a non-streamed
 * page / before any boundary reveals.
 */
export function getBoundaryTimings(): BoundaryTiming[] {
  if (!isDev()) return [];
  const byId = new Map<string, BoundaryTiming>();
  const order: string[] = [];
  const upsert = (id: string): BoundaryTiming => {
    let t = byId.get(id);
    if (!t) {
      t = { id, ms: 0 };
      byId.set(id, t);
      order.push(id);
    }
    return t;
  };
  try {
    // Real-time reveals first (order of arrival), carrying the template's server time.
    const reveals = (globalThis as { __denextBoundaries?: RevealRecord[] }).__denextBoundaries;
    if (Array.isArray(reveals)) {
      for (const r of reveals) {
        const t = upsert(r.id);
        t.revealAt = r.revealAt;
        if (r.serverMs != null) t.ms = r.serverMs;
      }
    }
  } catch {
    // Ignore a hostile/absent global.
  }
  try {
    // The end-of-stream island is authoritative for server resolve time when present.
    const doc = (globalThis as { document?: Document }).document;
    const el = doc?.getElementById("__denext_boundary_timing");
    if (el && el.textContent) {
      for (const b of JSON.parse(el.textContent) as Array<{ id: string; ms: number }>) {
        upsert(b.id).ms = b.ms;
      }
    }
  } catch {
    // Malformed/absent island — keep whatever the reveals gave us.
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * Subscribe to Suspense-boundary reveals — `fn` fires each time the swap runtime reveals
 * a streamed hole (a `denext:reveal` document event), so the panel's timeline can update
 * as holes land rather than only on the next commit. Returns an unsubscribe; no-op in
 * production or without a DOM.
 */
export function subscribeBoundaries(fn: () => void): () => void {
  if (!isDev()) return () => {};
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== "function") return () => {};
  const handler = () => fn();
  doc.addEventListener("denext:reveal", handler);
  return () => doc.removeEventListener("denext:reveal", handler);
}

// ---- Install ---------------------------------------------------------------

/** The `window.__denextDevtools` surface (and the `denext/devtools` module API). */
export interface DenextDevtoolsApi {
  /** The current component tree (see {@link getInspectorTree}). */
  getInspectorTree(): InspectNode[];
  /** Edit a `useState` cell live (see {@link setHookState}). */
  setHookState(fiberId: number, hookIndex: number, value: unknown): boolean;
  /** Dispatch to a `useReducer` cell live (see {@link dispatchReducer}). */
  dispatchReducer(fiberId: number, hookIndex: number, action: unknown): boolean;
  /** Set a `useRef` cell's `.current` live (see {@link setRefValue}). */
  setRefValue(fiberId: number, hookIndex: number, value: unknown): boolean;
  /** Read one level of a live value at a path (see {@link getValueAt}). */
  getValueAt(fiberId: number, ref: ValueRef, path: Array<string | number>): SerializedValue | null;
  /** `console.log` the live value at a path (see {@link logValueAt}). */
  logValueAt(fiberId: number, ref: ValueRef, path: Array<string | number>): boolean;
  /** Stash the live value at a path on `globalThis.$d` (see {@link storeAsGlobal}). */
  storeAsGlobal(fiberId: number, ref: ValueRef, path: Array<string | number>): string | null;
  /** Override a component's prop live (see {@link setPropOverride}). */
  setPropOverride(fiberId: number, key: string, value: unknown): boolean;
  /** Drop a component's live prop overrides (see {@link clearPropOverrides}). */
  clearPropOverrides(fiberId: number): boolean;
  /** The component ancestor/owner stack for a node (see {@link getOwnerStack}). */
  getOwnerStack(fiberId: number): Array<{ name: string; source?: string }>;
  /** Resolve a DOM node to its owning component id (see {@link getFiberIdForDom}). */
  getFiberIdForDom(el: Node | null): number | null;
  /** The host element for a fiber id (see {@link getHostNode}). */
  getHostNode(fiberId: number): Element | null;
  /** Start tracking why components render (see {@link enableRenderReasons}). */
  enableRenderReasons(): void;
  /** Stop tracking render reasons (see {@link disableRenderReasons}). */
  disableRenderReasons(): void;
  /** Why a component last rendered (see {@link getRenderReason}). */
  getRenderReason(fiberId: number): RenderReason | null;
  /** Subscribe to commits (see {@link subscribe}). */
  subscribe(fn: () => void): () => void;
  /** The render-mode view (see {@link getRenderModes}). */
  getRenderModes(): RenderModeEntry[];
  /** The server-emitted page render mode (see {@link getPageRenderMode}). */
  getPageRenderMode(): PageRenderMode | null;
  /** The per-Suspense-boundary timeline (see {@link getBoundaryTimings}). */
  getBoundaryTimings(): BoundaryTiming[];
  /** Subscribe to streamed-hole reveals (see {@link subscribeBoundaries}). */
  subscribeBoundaries(fn: () => void): () => void;
  /** Start recording per-component render timings (see {@link startProfiling}). */
  startProfiling(): void;
  /** Stop recording render timings (see {@link stopProfiling}). */
  stopProfiling(): void;
  /** Whether the profiler is recording (see {@link isProfiling}). */
  isProfiling(): boolean;
  /** The collected render profile (see {@link getProfile}). */
  getProfile(): ProfileEntry[];
  /** Discard the collected profile (see {@link resetProfile}). */
  resetProfile(): void;
  /** The recorded per-commit summaries (see {@link getCommits}). */
  getCommits(): CommitSummary[];
  /** The flamegraph for a recorded commit (see {@link getCommitTree}). */
  getCommitTree(index: number): FlameNode | null;
}

/**
 * Install the inspector API on `window.__denextDevtools` (idempotent). Returns the API,
 * or `null` in production / before `__denextDev`. Called by {@link installDevtools} in
 * the dev entries; also usable directly from the `denext/devtools` module.
 */
export function installInspector(): DenextDevtoolsApi | null {
  if (!isDev()) return null;
  const g = globalThis as { __denextDevtools?: DenextDevtoolsApi };
  if (g.__denextDevtools) return g.__denextDevtools;
  const api: DenextDevtoolsApi = {
    getInspectorTree,
    setHookState,
    dispatchReducer,
    setRefValue,
    getValueAt,
    logValueAt,
    storeAsGlobal,
    setPropOverride,
    clearPropOverrides,
    getOwnerStack,
    getFiberIdForDom,
    getHostNode,
    enableRenderReasons,
    disableRenderReasons,
    getRenderReason,
    subscribe,
    getRenderModes,
    getPageRenderMode,
    getBoundaryTimings,
    subscribeBoundaries,
    startProfiling,
    stopProfiling,
    isProfiling,
    getProfile,
    resetProfile,
    getCommits,
    getCommitTree,
  };
  g.__denextDevtools = api;
  // Wire the stock React DevTools bridge: give it the SAME fiber ids the native inspector
  // uses, and route the extension's prop/state edits back through our live setters. The
  // edit wrappers re-walk the tree first so the RD-supplied id resolves against a current
  // id→fiber map (the ids themselves are stable across walks).
  setDevIdForFiber(idFor);
  setInspectorBridge({
    setHookState: (id, i, v) => {
      getInspectorTree();
      return setHookState(id, i, v);
    },
    setPropOverride: (id, k, v) => {
      getInspectorTree();
      return setPropOverride(id, k, v);
    },
  });
  return api;
}
