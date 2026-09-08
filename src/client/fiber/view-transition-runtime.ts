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
// Fragment's props are dropped in Flight). Each transition is a `begin(types)` call that stamps
// the outgoing hosts NOW (before `startViewTransition`, so the old-state capture sees the names)
// and returns a handle whose markIncoming()/clear() operate only on THIS transition's elements —
// so overlapping navigations never wipe each other's stamps. A `name` present on both sides pairs
// the elements for a morph; `enter`/`exit`/`update`/`share` become `view-transition-class` on the
// old vs. new side.

import { DNX_VT_ATTR, type ViewTransitionMarker } from "../../runtime/react-extras.ts";
import { activeRoots } from "./state.ts";
import { type ActiveViewTransition, setViewTransitionSupport } from "./view-transition-support.ts";

// A `view-transition-name` / `view-transition-class` value is a CSS custom-ident. Only stamp
// values that ARE one, so a value bound to untrusted data (a shared-element name keyed by an id
// or title) can't inject extra CSS declarations into the element's inline style via an embedded
// `;`/`:`/`}`/quote (e.g. `x;position:fixed;inset:0;z-index:9999`). Non-conforming names/classes
// are dropped rather than stamped. (React sidesteps this by going through CSSOM, whose setter
// rejects invalid values; denext validates because it writes the style attribute as a string so
// the marking is observable in the no-CSSOM test DOM.)
const CSS_IDENT = /^-?[A-Za-z_][\w-]*$/;
function ident(value: string | undefined): string | undefined {
  return value != null && CSS_IDENT.test(value) ? value : undefined;
}

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

/** Join distinct, VALID class idents into one `view-transition-class` value (undefined when none). */
function joinClasses(...parts: (string | undefined)[]): string | undefined {
  const seen = new Set<string>();
  for (const p of parts) {
    if (!p) continue;
    for (const c of p.split(/\s+/)) {
      const safe = ident(c);
      if (safe) seen.add(safe);
    }
  }
  return seen.size ? [...seen].join(" ") : undefined;
}

/** Stamp `view-transition-name` (+ class) onto `el`, rebuilding from its ORIGINAL inline style (recorded in `marked`, first sight wins so a reused element restores cleanly). */
function stamp(
  marked: Map<Element, string | null>,
  el: Element,
  name: string | undefined,
  cls: string | undefined,
): void {
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
 * Begin one transition: stamp the CURRENT (outgoing) DOM's marked elements — the old side carries
 * `exit`/`update`/`share` classes (`::view-transition-old(name)`) — and return a handle that owns
 * this transition's stamped elements. `types` is fixed here for the whole transition, so an
 * overlapping nav can't change how this one's class maps resolve.
 */
function begin(types: readonly string[]): ActiveViewTransition {
  const marked = new Map<Element, string | null>();
  eachMarked((m, el) => {
    stamp(
      marked,
      el,
      ident(m.name),
      joinClasses(
        resolveClass(m.exit, types),
        resolveClass(m.update, types),
        resolveClass(m.share, types),
      ),
    );
  });
  return {
    // The new side carries `enter`/`update`/`share` classes (`::view-transition-new(name)`). A
    // reused element (a morph in place) is re-stamped from its original, so the incoming class wins.
    markIncoming() {
      eachMarked((m, el) => {
        stamp(
          marked,
          el,
          ident(m.name),
          joinClasses(
            resolveClass(m.enter, types),
            resolveClass(m.update, types),
            resolveClass(m.share, types),
          ),
        );
      });
    },
    clear() {
      for (const [el, original] of marked) {
        if (original == null) el.removeAttribute("style");
        else el.setAttribute("style", original);
      }
      marked.clear();
    },
  };
}

/**
 * Install the view-transition marking runtime into the reconciler seam. Emitted by the
 * generated entry (via `denext/client-runtime`) only when the app uses `<ViewTransition>`; the
 * dev server and tests install it directly. Idempotent.
 */
export function installViewTransitionSupport(): void {
  setViewTransitionSupport({ begin });
}
