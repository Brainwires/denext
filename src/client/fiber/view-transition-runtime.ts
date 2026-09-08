// The `<ViewTransition>` per-element marking runtime — the import-gated half of the feature.
// The generated entry calls installViewTransitionSupport() ONLY when a build scan sees
// `<ViewTransition>`, wiring this into the reconciler seam (view-transition-support.ts). An
// app that never renders one never references this module, so `deno bundle` tree-shakes it
// out — the same lever the class-component, Activity and Live runtimes use. The navigation
// runtime imports only the seam, never this file.
//
// A `<ViewTransition>` stamps its config as the DNX_VT_ATTR attribute on its host child (see
// react-extras.ts) — a DOM attribute, so it survives server rendering AND the Flight boundary
// (a VNode/Fragment marker would not: server components aren't re-run on the client and a
// Fragment's props are dropped in Flight). Around a transition the navigation runtime calls
// markOutgoing() BEFORE `startViewTransition` (so the browser's old-state capture sees the
// names) and markIncoming() inside the callback after the DOM commit (so the new-state
// capture sees them), then clear() when the transition finishes. Names are applied to the
// marked elements found in each root's live DOM; a `name` present on both sides pairs them for
// a morph, and `enter`/`exit`/`update`/`share` become `view-transition-class` on old vs. new.

import { DNX_VT_ATTR, type ViewTransitionMarker } from "../../runtime/react-extras.ts";
import { activeRoots } from "./state.ts";
import { getActiveTransitionTypes, setViewTransitionSupport } from "./view-transition-support.ts";

// Every element this transition stamped → its ORIGINAL inline `style` (first sight wins), so
// clear() restores exactly, and a reused element stamped both outgoing and incoming rebuilds
// from its original rather than compounding.
let marked = new Map<Element, string | null>();

/** Collect every marked element under `root` (inclusive), DFS via element children — portable across the real DOM and the test DOM shim (no querySelectorAll dependency). */
function collectMarked(root: Element, out: Element[]): void {
  if (typeof root.getAttribute === "function" && root.getAttribute(DNX_VT_ATTR) != null) {
    out.push(root);
  }
  const kids = root.children;
  for (let i = 0; i < kids.length; i++) collectMarked(kids[i] as Element, out);
}

/** Parse a marked element's {@link DNX_VT_ATTR} config, or null when absent/malformed. */
function markerOf(el: Element): ViewTransitionMarker | null {
  const raw = el.getAttribute(DNX_VT_ATTR);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as ViewTransitionMarker;
  } catch {
    return null;
  }
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

/** Join distinct class names into one `view-transition-class` value (undefined when none). */
function joinClasses(...parts: (string | undefined)[]): string | undefined {
  const seen = new Set<string>();
  for (const p of parts) {
    if (!p) continue;
    for (const c of p.split(/\s+/)) if (c) seen.add(c);
  }
  return seen.size ? [...seen].join(" ") : undefined;
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

/** Visit every marked element across all active roots' live DOM. */
function eachMarked(visit: (marker: ViewTransitionMarker, el: Element) => void): void {
  for (const handle of activeRoots) {
    const out: Element[] = [];
    collectMarked(handle.container, out);
    for (const el of out) {
      const m = markerOf(el);
      if (m) visit(m, el);
    }
  }
}

/**
 * Stamp the CURRENT (outgoing) DOM's marked elements — called BEFORE `startViewTransition`, so
 * the browser's old-state capture includes the names. The old side carries `exit`/`update`/
 * `share` classes (`::view-transition-old(name)` targets them).
 */
function markOutgoing(): void {
  const types = getActiveTransitionTypes();
  eachMarked((m, el) => {
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
 * Stamp the now-current (incoming) DOM's marked elements — called INSIDE the transition
 * callback after the commit, so the new-state capture includes the names. The new side carries
 * `enter`/`update`/`share` classes (`::view-transition-new(name)` targets them). A reused
 * element (a morph in place) is re-stamped from its original, so the incoming class wins.
 */
function markIncoming(): void {
  const types = getActiveTransitionTypes();
  eachMarked((m, el) => {
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
