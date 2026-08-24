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
import { devRootFibers, setCommitObserver } from "./fiber/reconciler.ts";
import { componentDisplayName } from "../runtime/react-brands.ts";
import { getIslandTimeline, type IslandHydration } from "./lazy-hydrate.ts";

// Hook-kind labels — mirror the `HK_*` constants in `fiber/reconciler.ts` (kept in
// sync by value). Only `state` cells are live-editable: a `state` setter accepts the
// next value directly, whereas a `reducer`'s dispatch expects an action, not a value.
const HOOK_KIND_LABELS: Record<number, string> = {
  1: "state", // HK_STATE
  2: "reducer", // HK_REDUCER
  3: "effect", // HK_EFFECT
  4: "memo", // HK_MEMO
  5: "ref", // HK_REF
  6: "id", // HK_ID
  7: "store", // HK_STORE
  8: "memoCache", // HK_MEMOCACHE
  9: "deferred", // HK_DEFERRED
  10: "layout", // HK_LAYOUT
  11: "insertion", // HK_INSERTION
};
const EDITABLE_KIND = 1; // HK_STATE

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
}

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
  if (Array.isArray(v)) return { preview: `Array(${v.length})`, type: "array" };
  let keys: string[] = [];
  try {
    keys = Object.keys(obj);
  } catch {
    // Exotic object with a throwing key enumerator — fall back to a bare preview.
  }
  const shown = keys.slice(0, 4).join(", ");
  const more = keys.length > 4 ? ", …" : "";
  return { preview: `{${shown}${more}}`, type: "object" };
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
  /** The node's props (shallow preview). */
  props: SerializedValue;
  /** Component hooks, in call order (empty for host/text/fragment). */
  hooks: InspectHook[];
  /** Contexts read this render (empty when none). */
  contexts: InspectContext[];
  /** Child nodes, in order. */
  children: InspectNode[];
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
    const editable = kind === EDITABLE_KIND && typeof cell.updater === "function" &&
      (value.type === "string" || value.type === "number" || value.type === "boolean" ||
        value.type === "null");
    out.push({ index: i, kind: HOOK_KIND_LABELS[kind] ?? "hook", value, editable });
  }
  return out;
}

function serializeContexts(fiber: Fiber): InspectContext[] {
  const read = fiber.readContexts;
  if (!read || read.size === 0) return [];
  const out: InspectContext[] = [];
  for (const sym of read) {
    out.push({
      name: sym.description ?? "Context",
      value: serializeValue(fiber.inherited.get(sym)),
    });
  }
  return out;
}

function buildNode(fiber: Fiber, idMap: Map<number, Fiber>): InspectNode {
  const id = idFor(fiber);
  idMap.set(id, fiber);
  const key = fiber.vnode.key == null ? null : String(fiber.vnode.key);
  const props = serializeValue(fiber.vnode.props);
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
        props,
        hooks: serializeHooks(fiber),
        contexts: serializeContexts(fiber),
        children,
      };
    case "suspense":
    case "errorboundary":
      return {
        id,
        name: fiber.tag === "suspense" ? "Suspense" : "ErrorBoundary",
        kind: "component",
        key,
        props,
        hooks: [],
        contexts: [],
        children,
      };
    case "fragment":
      return {
        id,
        name: "Fragment",
        kind: "fragment",
        key,
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

// ---- Commit subscription ---------------------------------------------------

type Sub = () => void;
const subs = new Set<Sub>();
let observing = false;

/**
 * Subscribe to commits — `fn` fires (cheaply) after every commit so a panel can
 * lazily re-pull {@link getInspectorTree}. Returns an unsubscribe. No-op (returns a
 * no-op) in production. The reconciler observer is installed only while ≥1 subscriber
 * is active.
 */
export function subscribe(fn: () => void): () => void {
  if (!isDev()) return () => {};
  subs.add(fn);
  if (!observing) {
    observing = true;
    setCommitObserver(() => {
      for (const s of subs) {
        try {
          s();
        } catch {
          // A subscriber must never break a commit.
        }
      }
    });
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0) {
      observing = false;
      setCommitObserver(null);
    }
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

// ---- Install ---------------------------------------------------------------

/** The `window.__denextDevtools` surface (and the `denext/devtools` module API). */
export interface DenextDevtoolsApi {
  /** The current component tree (see {@link getInspectorTree}). */
  getInspectorTree(): InspectNode[];
  /** Edit a `useState` cell live (see {@link setHookState}). */
  setHookState(fiberId: number, hookIndex: number, value: unknown): boolean;
  /** Subscribe to commits (see {@link subscribe}). */
  subscribe(fn: () => void): () => void;
  /** The render-mode view (see {@link getRenderModes}). */
  getRenderModes(): RenderModeEntry[];
  /** The server-emitted page render mode (see {@link getPageRenderMode}). */
  getPageRenderMode(): PageRenderMode | null;
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
    subscribe,
    getRenderModes,
    getPageRenderMode,
  };
  g.__denextDevtools = api;
  return api;
}
