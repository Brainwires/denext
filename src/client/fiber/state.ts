// Shared reconciler state that no single phase owns: the document to create nodes in,
// the root registry, and the commit-time flags beginWork raises. The per-phase
// singletons live with their owner (hook cursor → hooks-dispatcher, lanes / in-flight
// render → scheduler, hydration cursor → hydration) and are read through live-binding
// imports; only their owner assigns them. Nothing here imports another fiber module.

import type { Fiber } from "./fiber.ts";
import type { VNode } from "../../jsx/types.ts";
import "../../runtime/class-flag.ts";

/**
 * The document the render in progress creates nodes in. Resolved per root as its render
 * starts ({@link enterRootDocument}) — never captured at module load, so a document
 * installed after import (jsdom / happy-dom setups, test stubs) is the one used.
 */
export let doc: Document = undefined as unknown as Document;

/** An explicit document (a test DOM shim), used when a container has no `ownerDocument`. */
let docOverride: Document | null = null;

/** Override the document implementation (used by tests with a DOM shim). */
export function setDocument(d: Document): void {
  docOverride = d;
  doc = d;
}

/** The page's document outside a render: the {@link setDocument} override, else the global. */
export function currentDocument(): Document {
  return docOverride ?? (globalThis as { document?: Document }).document!;
}

/**
 * The document nodes for `container` are created in, as React does: the container itself
 * when it is a document, else its `ownerDocument`; for a container with neither (a bare
 * shim), the {@link setDocument} override, then the current global `document`.
 */
function documentFor(container: Node): Document {
  if (container.nodeType === 9) return container as Document;
  return container.ownerDocument ?? currentDocument();
}

/**
 * Set once a portal has targeted a container in a document other than its root's (an iframe's,
 * a popup window's). Until then every node is created in {@link doc} and
 * {@link documentForFiber} costs nothing; afterwards it walks up to the nearest portal.
 */
let crossDocumentPortals = false;

/** Record a portal's target as its fiber begins, so a cross-document one is noticed. */
export function notePortalTarget(target: Node | null | undefined): void {
  if (!crossDocumentPortals && target && documentFor(target) !== doc) crossDocumentPortals = true;
}

/**
 * The document a fresh node for `fiber` is created in, as React does: the nearest enclosing
 * portal's container's document, else the root's ({@link doc}). A node built in the wrong
 * document still works after `appendChild` adopts it, but custom-element upgrades, `instanceof`
 * checks against the target window's constructors, and styles read at creation would not.
 */
export function documentForFiber(fiber: Fiber): Document {
  if (!crossDocumentPortals) return doc;
  for (let f = fiber.return; f !== null; f = f.return) {
    if (f.tag === "portal" && f.stateNode) return documentFor(f.stateNode);
  }
  return doc;
}

/** Point node creation at `handle`'s document — called as each render (or slice) of it starts. */
export function enterRootDocument(handle: RootHandle): void {
  doc = documentFor(handle.container);
}

/** One mounted root: its container, committed tree and pending work. */
export interface RootHandle {
  container: Element;
  /** The committed HostRoot fiber (double-buffered via its alternate). */
  current: Fiber;
  pendingElement: VNode | null;
  pendingLanes: number;
  /** True for the first render of a hydrateRoot (adopt server DOM). */
  hydrate: boolean;
  /** Document-root hydration: the child to begin the cursor at (skips the doctype). */
  hydrateStart?: Node | null;
  /**
   * True when the container is the document itself (global-error hydration). The root's
   * children are then PLACED, not synced, so foreign top-level nodes (the doctype) survive.
   */
  documentRoot?: boolean;
  /** RootOptions error callbacks (React 19 parity), or undefined. */
  onCaughtError?: RootErrorCallback;
  onUncaughtError?: RootErrorCallback;
  onRecoverableError?: RootErrorCallback;
}

/** A RootOptions error callback. */
export type RootErrorCallback = (
  error: unknown,
  errorInfo: { componentStack?: string },
) => void;

/** Every mounted root, for scheduling and DevTools. */
export const activeRoots = new Set<RootHandle>();
/** Maps each buffer of a root fiber to its handle (both alternates included). */
export const fiberToRoot = new WeakMap<Fiber, RootHandle>();

/** The handle of the root `fiber` belongs to, or null if it is detached. */
export function rootHandleOf(fiber: Fiber): RootHandle | null {
  let n: Fiber | null = fiber;
  while (n !== null) {
    if (n.tag === "root") return fiberToRoot.get(n) ?? null;
    n = n.return;
  }
  return null;
}

/** Raised by beginWork when a `<Profiler>` rendered, so commitRoot fires onRender. */
export let anyProfiler = false;
/** Raised by beginWork when a Suspense boundary changed Offscreen state this render. */
let anyOffscreen = false;

export function noteProfiler(): void {
  anyProfiler = true;
}

export function noteOffscreen(): void {
  anyOffscreen = true;
}

/** Consume the Offscreen flag: true (once) if a boundary changed Offscreen state. */
export function takeOffscreen(): boolean {
  if (!anyOffscreen) return false;
  anyOffscreen = false;
  return true;
}
