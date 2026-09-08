// The `<ViewTransition>` per-element marking runtime — the import-gated half of the feature.
// The generated entry calls installViewTransitionSupport() ONLY when a build scan sees
// `<ViewTransition>`, wiring this into the reconciler seam (view-transition-support.ts). An
// app that never renders one never references this module, so `deno bundle` tree-shakes it
// out — the same lever the class-component, Activity and Live runtimes use. The navigation
// runtime imports only the seam, never this file.
//
// A `<ViewTransition>` renders as a Fragment carrying its config under the VIEW_TRANSITION
// symbol (a marker Fragment, like a context Provider / SuspenseList carrier — it keeps its
// own fiber). Around a view transition the navigation runtime calls markOutgoing() BEFORE
// `startViewTransition` (so the browser's old-state capture sees the names) and markIncoming()
// inside the transition callback after the DOM commit (so the new-state capture sees them),
// then clear() when the transition finishes. Names are stamped onto the wrapper's first host
// child; a `name` shared across the old and new trees pairs the two for a morph, and
// `enter`/`exit`/`update`/`share` become `view-transition-class` on the old vs. new side.

import { collectDom, type Fiber } from "./fiber.ts";
import { VIEW_TRANSITION, type ViewTransitionMarker } from "../../runtime/react-extras.ts";
import { activeRoots } from "./state.ts";
import { getActiveTransitionTypes, setViewTransitionSupport } from "./view-transition-support.ts";

// Every element this transition stamped → its ORIGINAL inline `style` (first sight wins), so
// clear() restores exactly, and a reused element stamped both outgoing and incoming rebuilds
// from its original rather than compounding.
let marked = new Map<Element, string | null>();

/** The wrapper's first host descendant — the element the name/class is stamped on. */
function firstHostEl(fiber: Fiber): Element | null {
  const out: (Element | Text)[] = [];
  collectDom(fiber, out);
  for (const n of out) if (n.nodeType === 1) return n as Element;
  return null;
}

/** The `<ViewTransition>` config on a marker Fragment fiber, or undefined for any other fiber. */
function markerOf(fiber: Fiber): ViewTransitionMarker | undefined {
  if (fiber.tag !== "fragment") return undefined;
  const props = fiber.vnode.props as Record<string, unknown> | null;
  return props?.[VIEW_TRANSITION as unknown as string] as ViewTransitionMarker | undefined;
}

/** Resolve a `view-transition-class` value: a plain string, or a type→class map keyed by the active transition types. */
function resolveClass(
  val: string | Record<string, string> | undefined,
  types: readonly string[],
): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val;
  for (const t of types) if (val[t] != null) return val[t];
  return val.default;
}

/** Join defined class names into one `view-transition-class` value (undefined when none). */
function joinClasses(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? kept.join(" ") : undefined;
}

/** Stamp `view-transition-name` (+ class) onto `el`, rebuilding from its ORIGINAL inline style. */
function stamp(el: Element, name: string | undefined, cls: string | undefined): void {
  if (!marked.has(el)) marked.set(el, el.getAttribute("style"));
  const original = marked.get(el) ?? null;
  let s = original?.trim() ?? "";
  if (s !== "" && !s.endsWith(";")) s += ";";
  if (name) s += `view-transition-name:${name};`;
  if (cls) s += `view-transition-class:${cls};`;
  if (s === "") el.removeAttribute("style");
  else el.setAttribute("style", s);
}

/** Visit every `<ViewTransition>` wrapper with a host child, across all active roots' current trees. */
function eachWrapper(visit: (marker: ViewTransitionMarker, el: Element) => void): void {
  const walk = (fiber: Fiber): void => {
    const m = markerOf(fiber);
    if (m) {
      const el = firstHostEl(fiber);
      if (el) visit(m, el);
    }
    for (let c = fiber.child; c !== null; c = c.sibling) walk(c);
  };
  for (const handle of activeRoots) walk(handle.current);
}

/**
 * Stamp the CURRENT (outgoing) tree's wrappers — called BEFORE `startViewTransition`, so the
 * browser's old-state capture includes the names. The old side carries `exit`/`update`/`share`
 * classes (`::view-transition-old(name)` targets them).
 */
function markOutgoing(): void {
  const types = getActiveTransitionTypes();
  eachWrapper((m, el) => {
    stamp(
      el,
      m.name,
      joinClasses(
        resolveClass(m.exit, types),
        resolveClass(m.update, types),
        resolveClass(m.share, types),
      ),
    );
  });
}

/**
 * Stamp the now-current (incoming) tree's wrappers — called INSIDE the transition callback
 * after the DOM commit, so the new-state capture includes the names. The new side carries
 * `enter`/`update`/`share` classes (`::view-transition-new(name)` targets them). A reused
 * element (a morph in place) is re-stamped from its original, so the incoming class wins.
 */
function markIncoming(): void {
  const types = getActiveTransitionTypes();
  eachWrapper((m, el) => {
    stamp(
      el,
      m.name,
      joinClasses(
        resolveClass(m.enter, types),
        resolveClass(m.update, types),
        resolveClass(m.share, types),
      ),
    );
  });
}

/** Restore every stamped element's original inline style — called when the transition finishes. */
function clear(): void {
  for (const [el, original] of marked) {
    if (original == null) el.removeAttribute("style");
    else el.setAttribute("style", original);
  }
  marked = new Map();
}

/**
 * Install the view-transition marking runtime into the reconciler seam. Emitted by the
 * generated entry (via `denext/client-runtime`) only when the app uses `<ViewTransition>`; the
 * dev server and tests install it directly. Idempotent.
 */
export function installViewTransitionSupport(): void {
  setViewTransitionSupport({ markOutgoing, markIncoming, clear });
}
