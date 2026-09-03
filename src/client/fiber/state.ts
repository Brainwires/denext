// Shared reconciler state that no single phase owns: the document to create nodes in,
// the root registry, and the commit-time flags beginWork raises. The per-phase
// singletons live with their owner (hook cursor → hooks-dispatcher, lanes / in-flight
// render → scheduler, hydration cursor → hydration) and are read through live-binding
// imports; only their owner assigns them. Nothing here imports another fiber module.

import type { Fiber } from "./fiber.ts";
import type { VNode } from "../../jsx/types.ts";
import "../../runtime/class-flag.ts";

/** The document to create nodes in; overridable for tests via {@link setDocument}. */
export let doc: Document = (globalThis as { document?: Document }).document!;

/** Override the document implementation (used by tests with a DOM shim). */
export function setDocument(d: Document): void {
  doc = d;
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
