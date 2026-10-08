// Client-reconciler seam for host singletons: a root layout rendered by client code (a client
// root layout, or a page/layout that calls a hook) puts `<html>`/`<head>`/`<body>` straight under
// the page container, and the reconciler adopts the page's own elements for them instead of
// nesting new ones. The core reaches the logic only through this null-default slot; the
// generated entry installs the real support (installSingletonSupport, singleton-runtime.ts) ONLY
// when a build scan sees a document tag in the app's sources, so an app whose root layout is a
// server component (or that has none, as denext supplies the document) ships none of it — the
// same lever the class-component, Activity and ViewTransition runtimes use. Without it, a
// document tag is an ordinary element.

import type { Fiber } from "./fiber.ts";

/** The singleton half of the reconciler: begin, complete, commit and release. */
export interface SingletonSupport {
  /** On mount, adopt the page's element for a document tag under a page-container root. */
  adopt(wip: Fiber): boolean;
  /** Render phase: flag the commit's attribute work (and note what hydration found). */
  complete(wip: Fiber): void;
  /** Mutation phase: write the props that changed onto the page's element. */
  commit(fiber: Fiber): void;
  /** Unmount: take back what this layout set; the element stays. */
  release(fiber: Fiber): void;
}

let support: SingletonSupport | null = null;

/** Install (or clear, with `null`) the singleton runtime. */
export function setSingletonSupport(s: SingletonSupport | null): void {
  support = s;
}

/** The installed singleton runtime, or null when the app renders no document tag. */
export function getSingletonSupport(): SingletonSupport | null {
  return support;
}
