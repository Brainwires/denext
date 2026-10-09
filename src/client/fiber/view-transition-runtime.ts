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
import { activeRoots, currentDocument, rootHandleOf } from "./state.ts";
import { anyRootHasLane, scheduleSyncFlush, settleTransitions } from "./scheduler.ts";
import { reportUncaught } from "./root-callbacks.ts";
import {
  type ActiveViewTransition,
  setViewTransitionSupport,
  takeTransitionTypes,
} from "./view-transition-support.ts";
import { devHydrationActive, walkFlagged } from "./fiber-utils.ts";
import {
  ChildDeletion,
  ChildrenChanged,
  type Fiber,
  hasBit,
  HiddenBit,
  OffscreenBit,
  Placement,
  SyncLane,
  Update,
} from "./fiber.ts";

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
  writeStyle(el, marked.get(el) ?? "", name, cls);
}

/** Write `base` (an inline style) plus a `view-transition-name` / `-class` as the `style` attribute. */
function writeStyle(
  el: Element,
  base: string,
  name: string | null | undefined,
  cls: string | null | undefined,
): void {
  let s = base.trim();
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

// ---- Same-page transitions (React 19.2's `<ViewTransition>` triggers) ----------------------
//
// A commit made only of Transition work (`eligible`: a transition, a deferred value, a Suspense
// reveal) runs inside `document.startViewTransition` when it affects a boundary — a host whose
// props carry DNX_VT_ATTR (the client tree has them for server- and client-rendered wrappers
// alike). Each boundary's trigger follows React's commit:
//
// - enter: the top-most boundaries of a freshly inserted subtree (or a revealed `<Activity>`);
// - exit: the top-most boundaries of a deleted subtree;
// - share: a named boundary that exits in one place while one of the same name enters in
//   another — both sides take `share` (nested named boundaries pair too);
// - update: a persisting boundary whose own subtree mutated, or that sits (top-most) under a
//   parent whose children changed and whose layout box moved. One that did not move is
//   cancelled (React hides its group the same way).
//
// The outgoing side is named before `startViewTransition` (the old-state capture), the incoming
// side inside the update callback after the commit, and every stamp is removed when the
// transition finishes. When no mutation lands outside a boundary, the root's own cross-fade is
// cancelled (`view-transition-name: none` on the document element), as React does.

/** One affected `<ViewTransition>` boundary: its host element and parsed config. */
interface Boundary {
  el: Element;
  m: ViewTransitionMarker;
}

/** The boundaries a Transition commit affects, gathered before mutation. */
interface Plan {
  enters: Boundary[];
  exits: Boundary[];
  /** Named boundaries entering / exiting anywhere in the changed subtrees (share pairing). */
  enterNamed: Map<string, Boundary>;
  exitNamed: Map<string, Boundary>;
  /** Persisting boundaries whose own subtree mutated. */
  updates: Boundary[];
  /** Persisting boundaries under a changed parent: animated only if their box moved. */
  layout: Boundary[];
  /** A mutation landed outside every boundary, so the root cross-fades too. */
  rootAffected: boolean;
}

const MUTATION = Placement | Update | ChildDeletion | ChildrenChanged;
const CHILD_LIST = ChildDeletion | ChildrenChanged;

/** A host fiber's `<ViewTransition>` config, or null. */
function markerOfFiber(f: Fiber): ViewTransitionMarker | null {
  if (f.tag !== "host") return null;
  const raw = (f.vnode.props as Record<string, unknown> | null)?.[DNX_VT_ATTR];
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as ViewTransitionMarker;
  } catch {
    return null;
  }
}

/** A named boundary's explicit name (`"auto"` and unset are automatic). */
function explicitName(m: ViewTransitionMarker): string | undefined {
  return m.name != null && m.name !== "auto" ? ident(m.name) : undefined;
}

/**
 * Gather the boundaries of `f`'s subtree (inclusive): the top-most into `top`, every named one
 * into `named` (pairs form at any depth). Hidden (`<Activity>`/Offscreen) content is skipped.
 */
function boundariesIn(
  f: Fiber,
  top: Boundary[],
  named: Map<string, Boundary>,
  isTop = true,
): void {
  if (hasBit(f, HiddenBit) || (f.tag === "activity" && hasBit(f, OffscreenBit))) return;
  const m = markerOfFiber(f);
  if (m !== null) {
    const b = { el: f.stateNode as Element, m };
    if (isTop) top.push(b);
    const name = explicitName(m);
    if (name) named.set(name, b);
    isTop = false;
  }
  for (let c = f.child; c !== null; c = c.sibling) boundariesIn(c, top, named, isTop);
}

/** Whether every top-level DOM node of `f`'s subtree is a boundary (so it isn't a root change). */
function allTopMarked(f: Fiber): boolean {
  if (f.tag === "text") return false;
  if (f.tag === "host") return markerOfFiber(f) !== null;
  for (let c = f.child; c !== null; c = c.sibling) if (!allTopMarked(c)) return false;
  return true;
}

/** Whether a child-list change of `f` moved only boundaries (a reorder of wrapped items). */
function childrenAllMarked(f: Fiber): boolean {
  for (let c = f.child; c !== null; c = c.sibling) if (!allTopMarked(c)) return false;
  return true;
}

/**
 * Walk the work-in-progress tree's changed paths (flags are live: this runs before the commit),
 * classifying boundaries. `insideVT`: an ancestor is a boundary (mutations belong to it, not the
 * root). `changed`: a parent's child list changed with no boundary in between (layout candidates).
 */
function scan(f: Fiber, plan: Plan, insideVT: boolean, changed: boolean): void {
  if (f.deletions) {
    for (const d of f.deletions) {
      boundariesIn(d, plan.exits, plan.exitNamed);
      if (!insideVT && !allTopMarked(d)) plan.rootAffected = true;
    }
  }
  if (!insideVT && (f.flags & ChildrenChanged) !== 0 && !childrenAllMarked(f)) {
    plan.rootAffected = true;
  }
  for (let c = f.child; c !== null; c = c.sibling) scanChild(c, plan, insideVT, changed);
}

function scanChild(c: Fiber, plan: Plan, insideVT: boolean, changed: boolean): void {
  if (hasBit(c, HiddenBit)) return;
  if (c.alternate === null) return scanFresh(c, plan, insideVT);
  if (c.tag === "activity" && scanActivity(c, plan)) return;
  const flags = c.flags | c.subtreeFlags;
  const m = classify(c, plan, flags, insideVT, changed);
  // Below a boundary only its own nested boundaries' changes matter; below a changed parent
  // the top-most boundaries are layout candidates, so descend even through clean subtrees.
  descend(
    c,
    plan,
    (flags & MUTATION) !== 0,
    insideVT || m !== null,
    (c.flags & CHILD_LIST) !== 0 || (m === null && changed),
  );
}

/** Scan `c`'s children when it has changes below it, or sits under a changed parent. */
function descend(
  c: Fiber,
  plan: Plan,
  mutated: boolean,
  insideVT: boolean,
  changed: boolean,
): void {
  if (mutated || changed) scan(c, plan, insideVT, changed);
}

/** A freshly inserted subtree: its top-most boundaries enter; unwrapped content changes the root. */
function scanFresh(c: Fiber, plan: Plan, insideVT: boolean): void {
  boundariesIn(c, plan.enters, plan.enterNamed);
  if (!insideVT && !allTopMarked(c)) plan.rootAffected = true;
}

/** An `<Activity>`: true when handled — hidden content is skipped, a revealed one's boundaries enter. */
function scanActivity(c: Fiber, plan: Plan): boolean {
  if (hasBit(c, OffscreenBit)) return true;
  if (!hasBit(c.alternate!, OffscreenBit)) return false;
  for (let k = c.child; k !== null; k = k.sibling) boundariesIn(k, plan.enters, plan.enterNamed);
  return true;
}

/**
 * A persisting fiber: a boundary is an update (its subtree mutated) or a layout candidate (under
 * a changed parent); an unwrapped host/text mutation outside every boundary changes the root.
 */
function classify(
  c: Fiber,
  plan: Plan,
  flags: number,
  insideVT: boolean,
  changed: boolean,
): ViewTransitionMarker | null {
  const m = markerOfFiber(c);
  if (m !== null) {
    const b = { el: c.stateNode as Element, m };
    if ((flags & MUTATION) !== 0) plan.updates.push(b);
    else if (changed) plan.layout.push(b);
  } else if (!insideVT && (c.flags & Update) !== 0 && (c.tag === "host" || c.tag === "text")) {
    plan.rootAffected = true;
  }
  return m;
}

/** Classify the commit, or null when no boundary is affected (nothing to animate). */
function planTransition(wipRoot: Fiber): Plan | null {
  const plan: Plan = {
    enters: [],
    exits: [],
    enterNamed: new Map(),
    exitNamed: new Map(),
    updates: [],
    layout: [],
    rootAffected: false,
  };
  scan(wipRoot, plan, false, (wipRoot.flags & CHILD_LIST) !== 0);
  const any = plan.enters.length + plan.exits.length + plan.updates.length + plan.layout.length;
  return any > 0 ? plan : null;
}

/** React's `getClassNameByType`: a class map resolved by the active transition types. */
function classByType(
  v: string | Record<string, string> | undefined,
  types: readonly string[],
): string | undefined {
  if (v == null || typeof v === "string") return v;
  let cls: string | undefined;
  for (const t of types) {
    const match = v[t];
    if (match == null) continue;
    if (match === "none") return "none";
    cls = cls == null ? match : `${cls} ${match}`;
  }
  return cls ?? v.default;
}

/**
 * React's `getViewTransitionClassName`: the trigger's own class, else `default`; `"auto"` means
 * no class (the browser's default animation), `"none"` means the boundary does not animate.
 */
function classFor(
  m: ViewTransitionMarker,
  event: "enter" | "exit" | "update" | "share",
  types: readonly string[],
): string | null {
  const cls = classByType(m[event], types) ?? classByType(m.default, types);
  return cls == null || cls === "auto" ? null : cls;
}

let autoNames = 0;
const autoNameOf = new WeakMap<Element, string>();

/** The boundary's `view-transition-name`: its own, else a stable automatic one per element. */
function nameOf(b: Boundary): string {
  const own = explicitName(b.m);
  if (own) return own;
  let auto = autoNameOf.get(b.el);
  if (!auto) autoNameOf.set(b.el, auto = `_dnx-vt-${(autoNames++).toString(32)}`);
  return auto;
}

/**
 * Set (or with nulls, remove) this element's `view-transition-name` / `-class`, leaving every
 * other declaration alone — through CSSOM where present (a commit's per-property style patch
 * then keeps them too), else by editing the `style` attribute (a DOM without CSSOM).
 */
function setVT(el: Element, name: string | null, cls: string | null): void {
  const st = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (st && typeof st.setProperty === "function") {
    setProp(st, "view-transition-name", name);
    setProp(st, "view-transition-class", cls);
  } else {
    const base = (el.getAttribute("style") ?? "").replace(
      /view-transition-(?:name|class):[^;]*;?/g,
      "",
    );
    writeStyle(el, base, name, cls);
  }
}

function setProp(st: CSSStyleDeclaration, prop: string, value: string | null): void {
  if (value) st.setProperty(prop, value);
  else st.removeProperty(prop);
}

/** A layout box to compare across the commit (null where the DOM has no layout). */
function boxOf(el: Element): string | null {
  const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
  return r ? `${r.left},${r.top},${r.width},${r.height}` : null;
}

/** The document type the runtime drives (the View Transitions API is optional). */
type VTDocument = Document & {
  startViewTransition?: (
    arg: (() => void) | { update: () => void; types?: string[] },
  ) => { ready?: Promise<void>; finished?: Promise<void>; updateCallbackDone?: Promise<void> };
};

/** A commit waiting for its view transition's update callback, applied by {@link flush}. */
let deferred: (() => void) | null = null;

function flush(): void {
  const d = deferred;
  deferred = null;
  d?.();
}

/** The elements a same-page transition stamped (cleared when it finishes). */
interface Stamps {
  els: Element[];
  set(b: Boundary, cls: string | null, name?: string): void;
}

function stamps(): Stamps {
  const els: Element[] = [];
  return {
    els,
    set(b, cls, name = nameOf(b)) {
      if (cls === "none") return;
      setVT(b.el, name, joinClasses(cls ?? undefined) ?? null);
      els.push(b.el);
    },
  };
}

/** `event`'s class for `b`, or `share`'s when a same-named boundary is on the other side. */
function pairedClass(
  b: Boundary,
  event: "enter" | "exit",
  other: Map<string, Boundary>,
  types: readonly string[],
): string | null {
  const name = explicitName(b.m);
  return classFor(b.m, name && other.has(name) ? "share" : event, types);
}

/**
 * Name the OUTGOING side before the old-state capture: exits (or a pair's old half — a nested
 * named boundary only when paired), then updates and layout candidates. Returns the candidates'
 * boxes, compared after the commit.
 */
function stampOutgoing(
  plan: Plan,
  types: readonly string[],
  out: Stamps,
): Map<Element, string | null> {
  for (const b of plan.exits) out.set(b, pairedClass(b, "exit", plan.enterNamed, types));
  for (const [name, b] of plan.exitNamed) {
    if (plan.enterNamed.has(name) && !plan.exits.includes(b)) {
      out.set(b, classFor(b.m, "share", types));
    }
  }
  const before = new Map<Element, string | null>();
  for (const b of plan.updates.concat(plan.layout)) {
    out.set(b, classFor(b.m, "update", types));
    before.set(b.el, boxOf(b.el));
  }
  return before;
}

/** Name the INCOMING side after the commit: enters (or a pair's new half), updates, moved candidates. */
function stampIncoming(
  plan: Plan,
  types: readonly string[],
  out: Stamps,
  before: Map<Element, string | null>,
  root: Element | null,
): void {
  for (const b of plan.enters) out.set(b, pairedClass(b, "enter", plan.exitNamed, types));
  for (const [name, b] of plan.enterNamed) {
    if (plan.exitNamed.has(name) && !plan.enters.includes(b)) {
      out.set(b, classFor(b.m, "share", types));
    }
  }
  for (const b of plan.updates) out.set(b, classFor(b.m, "update", types));
  for (const b of plan.layout) {
    const was = before.get(b.el);
    if (was != null && was !== boxOf(b.el)) out.set(b, classFor(b.m, "update", types));
    else cancelUnmoved(b, root);
  }
}

/**
 * An unmoved, unchanged layout candidate is no update: unname its new side and hide the old
 * group's snapshot so the live element shows through (React cancels it the same way).
 */
function cancelUnmoved(b: Boundary, root: Element | null): void {
  const name = nameOf(b);
  setVT(b.el, null, null);
  (root as HTMLElement & { animate?: HTMLElement["animate"] })?.animate?.(
    { opacity: [0, 0], pointerEvents: ["none", "none"] },
    { duration: 0, fill: "forwards", pseudoElement: `::view-transition-group(${name})` },
  );
}

/**
 * Cancel the root's own cross-fade when no mutation landed outside a boundary (as React does);
 * returns the undo, run when the transition finishes.
 */
function cancelRootCrossFade(root: HTMLElement | null, plan: Plan): () => void {
  if (plan.rootAffected || root?.style?.getPropertyValue("view-transition-name") !== "") {
    return () => {};
  }
  root.style.setProperty("view-transition-name", "none");
  return () => root.style.removeProperty("view-transition-name");
}

/**
 * A deferred commit threw — in the transition's update callback or a later {@link flush}, outside
 * the work loop that recovers a commit failing in place. Settle what the commit would have (a
 * time-sliced transition's `isPending`, queued sync work), then report the error as the root's
 * uncaught one: its `onUncaughtError`, else the global error handler, as React's default is.
 */
function commitFailed(wipRoot: Fiber, error: unknown): void {
  if (anyRootHasLane(SyncLane)) scheduleSyncFlush();
  settleTransitions();
  const report = (globalThis as { reportError?: (e: unknown) => void }).reportError;
  if (rootHandleOf(wipRoot)?.onUncaughtError) reportUncaught(wipRoot, error);
  else if (typeof report === "function") report(error);
  else console.error("denext: a transition commit failed", error);
}

/** Hold `run` until the transition's update callback (or {@link flush}); returns the trigger. */
function deferCommit(wipRoot: Fiber, run: () => void): () => void {
  let committed = false;
  const commitNow = () => {
    if (committed) return;
    committed = true;
    if (deferred === commitNow) deferred = null;
    try {
      run();
    } catch (error) {
      commitFailed(wipRoot, error);
    }
  };
  deferred = commitNow;
  return commitNow;
}

/** Start the view transition; without one (it threw), apply + finish right away. */
function startTransition(
  doc: VTDocument,
  types: string[],
  update: () => void,
  done: () => void,
): void {
  let tx: ReturnType<NonNullable<VTDocument["startViewTransition"]>> | undefined;
  try {
    tx = doc.startViewTransition!(types.length > 0 ? { update, types } : update);
  } catch {
    tx = undefined;
  }
  if (!tx) {
    update();
    done();
    return;
  }
  tx.ready?.catch(() => {}); // a skipped transition is not an error
  tx.updateCallbackDone?.catch((err) => console.error("denext: a transition commit failed", err));
  (tx.finished ?? Promise.resolve()).then(done, done);
}

/**
 * Run a Transition commit inside `document.startViewTransition` (see the section comment): name
 * the outgoing side now, apply the commit + name the incoming side in the update callback, and
 * clear every stamp (and the root's cancelled cross-fade) when the transition finishes.
 */
function animateCommit(doc: VTDocument, wipRoot: Fiber, plan: Plan, run: () => void): void {
  const types = takeTransitionTypes();
  const out = stamps();
  const before = stampOutgoing(plan, types, out);
  const root = doc.documentElement as HTMLElement | null;
  const restoreRoot = cancelRootCrossFade(root, plan);
  const commitNow = deferCommit(wipRoot, run);
  startTransition(doc, types, () => {
    commitNow();
    stampIncoming(plan, types, out, before, root);
  }, () => {
    for (const el of out.els) setVT(el, null, null);
    restoreRoot();
  });
}

/** Named boundaries mounted by a commit, for the dev duplicate-name check after it lands. */
function mountedNames(wipRoot: Fiber): Boundary[] {
  const out: Boundary[] = [];
  walkFlagged(wipRoot, Placement, (f) => {
    if (f.alternate !== null || (f.flags & Placement) === 0) return;
    const m = markerOfFiber(f);
    if (m !== null && explicitName(m)) out.push({ el: f.stateNode as Element, m });
  });
  return out;
}

const liveNames = new Map<string, Element>();
const warnedNames = new Set<string>();

/** React's dev warning: a `<ViewTransition name>` must be unique among mounted ones. */
function warnDuplicateNames(mounted: Boundary[]): void {
  for (const b of mounted) {
    const name = explicitName(b.m)!;
    const live = liveNames.get(name);
    if (live && live !== b.el && live.isConnected) {
      if (warnedNames.has(name)) continue;
      warnedNames.add(name);
      console.error(
        `denext: There are two <ViewTransition name=${JSON.stringify(name)}> components with ` +
          "the same name mounted at the same time. This is not supported and will cause View " +
          "Transitions to error. Use a more unique name, e.g. a namespace prefix plus the item's id.",
      );
    } else {
      liveNames.set(name, b.el);
    }
  }
}

/** The work loop's commit hook (see {@link ViewTransitionSupport.commit}). */
function commit(wipRoot: Fiber, eligible: boolean, run: () => void): void {
  const mounted = devHydrationActive() ? mountedNames(wipRoot) : null;
  const apply = mounted ? () => (run(), warnDuplicateNames(mounted)) : run;
  const doc = currentDocument() as VTDocument | undefined;
  const plan = eligible && typeof doc?.startViewTransition === "function"
    ? planTransition(wipRoot)
    : null;
  if (plan === null) apply();
  else animateCommit(doc!, wipRoot, plan, apply);
}

/**
 * Install the view-transition marking runtime into the reconciler seam. Emitted by the
 * generated entry (via `denext/client-runtime`) only when the app uses `<ViewTransition>`; the
 * dev server and tests install it directly. Idempotent.
 */
export function installViewTransitionSupport(): void {
  setViewTransitionSupport({ begin, commit, flush });
}
