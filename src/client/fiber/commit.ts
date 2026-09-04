// Commit phase: the ordered mutation / placement / effect phases of commitRoot,
// deletion, Offscreen visibility, profilers and the passive-effect queue.

import type { RootHandle } from "./state.ts";
import { collectEffects, collectInsertionEffects, needsSync, walk } from "./fiber-utils.ts";
import { reportCommit } from "./devtools-bridge.ts";
import { onErrorFor, scheduleEffectError } from "./boundaries.ts";
import type { ProfilerPhase } from "../../runtime/profiler.ts";
import { applyProps, detachRef } from "../dom-props.ts";
import { captureSnapshot, unmountClassInstance } from "../../compat/class-component.ts";
import { anyProfiler, takeOffscreen } from "./state.ts";
import {
  childrenDom,
  collectDom,
  type CommitEffect,
  type Fiber,
  type HookCell,
  NoFlags,
  NoLane,
  placePortalChildren,
  Snapshot,
  syncChildren,
  Update,
} from "./fiber.ts";

/** 1. Before mutation: class getSnapshotBeforeUpdate. */
function commitBeforeMutation(wipRoot: Fiber): void {
  if (!__DENEXT_CLASS_COMPONENTS__) return;
  walk(wipRoot, (f) => {
    if ((f.flags & Snapshot) !== 0) captureSnapshot(f as never);
  });
}

/**
 * 1a. Deletions first — an unmounting fiber runs its effect cleanups (including any
 *     useInsertionEffect cleanup) here, BEFORE the new fibers' insertion-effect setups.
 *     This is React's cleanup-before-setup ordering: on a sibling swap, the old
 *     sibling's insertion cleanup precedes the new sibling's insertion setup (e.g. a
 *     CSS-in-JS library removes the old <style> before inserting the replacement).
 */
function commitDeletions(wipRoot: Fiber): void {
  walk(wipRoot, (f) => {
    if (f.deletions) { for (const d of f.deletions) commitDeletion(d); }
  });
}

/**
 * 1b. Insertion effects (useInsertionEffect) run before the DOM host mutations and
 *     layout reads that follow — React's guarantee that a CSS-in-JS library's style
 *     insertion precedes any layout read. Collected over the work-in-progress tree (its
 *     child / sibling links are already built by render), which excludes any fiber
 *     discarded by a suspense/error unwind, exactly like the layout collection.
 */
function commitInsertionEffects(wipRoot: Fiber): void {
  const insertionFibers: Fiber[] = [];
  collectInsertionEffects(wipRoot, insertionFibers);
  runCommitEffects(insertionFibers, (f) => {
    const es = f.insertionEffects;
    f.insertionEffects = [];
    return es;
  });
}

/** 2. Mutation: host/text property updates. */
function commitMutation(wipRoot: Fiber): void {
  walk(wipRoot, (f) => {
    if ((f.flags & Update) === 0) return;
    if (f.tag === "host") {
      applyProps(
        f.stateNode as Element,
        f,
        (f.alternate?.vnode.props ?? {}) as Record<string, unknown>,
        (f.vnode.props ?? {}) as Record<string, unknown>,
        onErrorFor(f),
      );
    } else if (f.tag === "text") {
      (f.stateNode as Text).nodeValue = String(f.vnode.props.nodeValue ?? "");
    }
  });
}

/** 4. Placement: arrange DOM children of the root and any changed host/portal. */
function commitPlacement(handle: RootHandle, wipRoot: Fiber): void {
  syncChildren(handle.container, childrenDom(wipRoot));
  walk(wipRoot, (f) => {
    if (f.tag === "host" && f.alternate !== null && needsSync(f)) {
      syncChildren(f.stateNode as Element, childrenDom(f));
    } else if (f.tag === "portal" && needsSync(f)) {
      // A portal target (e.g. document.body) is shared with foreign nodes (#root, the
      // entry script, other portals), so place only this portal's own nodes — never
      // prune siblings the reconciler didn't insert.
      placePortalChildren(f.stateNode as Element, childrenDom(f));
    }
  });
}

/**
 * 4b. Clear committed effect flags across the whole tree. A fully-bailed subtree on a
 *     later render keeps its *current* fibers (not cloned via createWorkInProgress), so
 *     leftover flags/deletions here would be re-processed by that later commit's walk —
 *     double-running deletions (double cleanup / willUnmount) or re-applying props.
 *     Reset so the next commit starts clean.
 */
function clearCommittedFlags(wipRoot: Fiber): void {
  walk(wipRoot, (f) => {
    f.flags = NoFlags;
    f.subtreeFlags = NoFlags;
    f.deletions = null;
  });
}

/**
 * 5. Layout effects (useLayoutEffect / class didMount + didUpdate) run synchronously
 *    now, after mutation and before paint, in mount DFS order. Passive effects
 *    (useEffect) are deferred to a scheduled task after the commit. Effects are
 *    collected by walking the COMMITTED tree (post-order, so children run before
 *    parents), which excludes any fiber discarded by a suspense/error unwind — its
 *    effects must not run for content never placed.
 */
function commitLayoutEffects(wipRoot: Fiber): void {
  const effects: Fiber[] = [];
  collectEffects(wipRoot, effects);
  runCommitEffects(effects, (f) => {
    const es = f.pendingEffects;
    f.pendingEffects = [];
    return es;
  });
  for (const f of effects) {
    if (f.passiveEffects && f.passiveEffects.length > 0) pendingPassive.push(f);
  }
  if (pendingPassive.length > 0) schedulePassiveFlush();
}

/** Commit a fully rendered work-in-progress tree, in React's phase order. */
export function commitRoot(handle: RootHandle, wipRoot: Fiber): void {
  commitBeforeMutation(wipRoot);
  commitDeletions(wipRoot);
  commitInsertionEffects(wipRoot);
  commitMutation(wipRoot);
  // 3. Atomic swap: the work-in-progress tree becomes current.
  handle.current = wipRoot;
  commitPlacement(handle, wipRoot);
  clearCommittedFlags(wipRoot);
  // 4c. Offscreen visibility: hide the primary portion of a boundary that re-suspended
  //     urgently (display:none, kept mounted so its state survives), and restore it on
  //     reveal. Skipped entirely unless a boundary changed Offscreen state this commit.
  if (takeOffscreen()) walk(wipRoot, applyOffscreenVisibility);
  commitLayoutEffects(wipRoot);
  // 5b. Profiler onRender.
  if (anyProfiler) fireProfilers(wipRoot);
  // 6. DevTools.
  reportCommit(handle);
}

/**
 * Prior `style` attribute of each element hidden by Offscreen, so reveal restores it
 * exactly (an element may carry its own inline `style`, e.g. `display:flex`). `null`
 * means the element had no `style` attribute before it was hidden.
 */
const offscreenPrevStyle = new WeakMap<Element, string | null>();

/**
 * Commit-time visibility for an Offscreen Suspense boundary. On its first Offscreen
 * commit, hide the DOM of its primary portion (the first `primaryCount` children) with
 * an inline `display:none !important` (matching React, which overrides author CSS —
 * unlike the `hidden` attribute, which `[hidden]{display:…}` rules can defeat); on
 * reveal, restore each element's prior inline style. The subtree stays mounted
 * throughout, so its state lives.
 */
/**
 * Hide one element with inline `display:none !important`, remembering its prior style.
 * Appended at the end so the declaration wins over any prior `display` in the element's
 * own inline style (later + `!important` declaration wins).
 */
function hideElement(el: Element): void {
  const prev = el.getAttribute("style");
  offscreenPrevStyle.set(el, prev);
  const trimmed = prev?.trim() ?? "";
  const base = trimmed === "" ? "" : (trimmed.endsWith(";") ? trimmed : trimmed + ";");
  el.setAttribute("style", base + "display:none !important");
}

/** Undo {@linkcode hideElement}: restore the prior inline style (or remove it). */
function restoreElement(el: Element): void {
  const prev = offscreenPrevStyle.get(el);
  if (prev == null) el.removeAttribute("style");
  else el.setAttribute("style", prev);
  offscreenPrevStyle.delete(el);
}

/**
 * First hide: hide the primary DOM AND disconnect its effects — a timer or subscription
 * registered in the hidden subtree must stop while it's offscreen (state in
 * useState/useRef cells is untouched, so it survives the reveal).
 */
function hideOffscreenPrimary(f: Fiber): void {
  const dom: (Element | Text)[] = [];
  let c = f.child;
  for (let i = 0; c !== null && i < f.primaryCount!; c = c.sibling, i++) {
    collectDom(c, dom);
    disconnectEffects(c);
  }
  const els: Element[] = [];
  for (const n of dom) {
    if (n.nodeType !== 1) continue;
    hideElement(n as Element);
    els.push(n as Element);
  }
  f.hiddenEls = els;
}

/**
 * Reveal: restore the DOM and reconnect the effects torn down on hide. By now beginWork
 * has cleared primaryCount and reconciled just the primary content, so every child of
 * `f` is a revealed primary fiber.
 */
function revealOffscreenPrimary(f: Fiber): void {
  for (const el of f.hiddenEls!) restoreElement(el);
  f.hiddenEls = undefined;
  for (let c = f.child; c !== null; c = c.sibling) reconnectEffects(c);
}

function applyOffscreenVisibility(f: Fiber): void {
  if (f.tag !== "suspense") return;
  const shouldHide = f.offscreen === true && f.showingFallback === true &&
    f.primaryCount != null;
  if (shouldHide && f.hiddenEls == null) hideOffscreenPrimary(f);
  else if (!shouldHide && f.hiddenEls != null) revealOffscreenPrimary(f);
}

/**
 * Visit every hook cell of every component fiber in an Offscreen subtree, children
 * before parents (unmount order). A nested boundary that is itself offscreen owns its
 * own effect state — it (and its subtree) is left alone so an outer hide/reveal doesn't
 * fight its lifecycle.
 */
function forEachOffscreenCell(fiber: Fiber, visit: (fiber: Fiber, cell: HookCell) => void): void {
  if (fiber.tag === "suspense" && fiber.hiddenEls != null) return;
  for (let c = fiber.child; c !== null; c = c.sibling) forEachOffscreenCell(c, visit);
  if (fiber.tag !== "component" || !fiber.hooks) return;
  for (const cell of fiber.hooks) visit(fiber, cell);
}

/** Run an effect cell's cleanup and mark it disconnected; a throwing cleanup is routed to a boundary. */
function disconnectCell(fiber: Fiber, cell: HookCell): void {
  if (!cell.reconnect || cell.disconnected === true) return;
  if (typeof cell.cleanup === "function") {
    try {
      cell.cleanup();
    } catch (err) {
      scheduleEffectError(fiber, err);
    }
  }
  cell.cleanup = undefined;
  cell.disconnected = true;
}

/** Re-run a disconnected effect cell's setup. */
function reconnectCell(fiber: Fiber, cell: HookCell): void {
  if (cell.disconnected !== true) return;
  cell.disconnected = false;
  try {
    cell.reconnect!();
  } catch (err) {
    scheduleEffectError(fiber, err);
  }
}

/**
 * Tear down every passive/layout effect in an Offscreen subtree (children before
 * parents, unmount order), leaving state cells intact. Each effect cell keeps a
 * `reconnect` thunk so {@linkcode reconnectEffects} can rebuild it on reveal.
 */
function disconnectEffects(fiber: Fiber): void {
  forEachOffscreenCell(fiber, disconnectCell);
}

/** Re-run the setup of every effect a prior {@linkcode disconnectEffects} tore down. */
function reconnectEffects(fiber: Fiber): void {
  forEachOffscreenCell(fiber, reconnectCell);
}

/**
 * For each committed `<Profiler>` boundary, fire its `onRender` with the subtree's
 * `actualDuration` (components that rendered this commit) and `baseDuration` (every
 * component's most-recent render time, so a fully-memoized commit has actual ≪ base).
 */
function fireProfilers(root: Fiber): void {
  const commitTime = performance.now();
  walk(root, (f) => {
    if (f.profiler == null) return;
    let actual = 0;
    let base = 0;
    walk(f, (d) => {
      actual += d.actualDuration ?? 0;
      base += d.selfBaseDuration ?? 0;
    });
    const phase: ProfilerPhase = f.profilerMounted ? "update" : "mount";
    f.profilerMounted = true;
    f.profiler.onRender?.(f.profiler.id, phase, actual, base, commitTime - actual, commitTime);
  });
}

/**
 * Run one commit phase's effects across `fibers` in React's two-pass order: EVERY
 * effect's cleanup first, then EVERY effect's setup. `take` drains a fiber's queue
 * so it isn't re-run. A plain thunk (a class-lifecycle entry with no `.cleanup`)
 * only participates in the setup pass. An error routes to a boundary without
 * skipping the rest of the pass.
 *
 * This all-cleanups-before-all-setups ordering is the key fix (M8): bundling a
 * cleanup with its own setup would let sibling B's setup run before sibling A's
 * cleanup, breaking a shared-resource handoff.
 */
function runCommitEffects(
  fibers: Fiber[],
  take: (f: Fiber) => CommitEffect[] | undefined,
): void {
  const pairs: Array<[Fiber, CommitEffect]> = [];
  for (const f of fibers) {
    const es = take(f);
    if (es) { for (const e of es) pairs.push([f, e]); }
  }
  for (const [f, e] of pairs) {
    if (typeof e.cleanup === "function") {
      try {
        e.cleanup();
      } catch (err) {
        scheduleEffectError(f, err); // route to a boundary; don't skip the pass
      }
    }
  }
  for (const [f, e] of pairs) {
    try {
      e();
    } catch (err) {
      scheduleEffectError(f, err); // route to a boundary; don't skip the pass
    }
  }
}

// ---- Passive effects (useEffect): scheduled after commit -------------------
// React runs passive effects on a task after paint, separate from the synchronous
// layout phase. denext schedules them on a macrotask and flushes them
// synchronously at the points React does: before starting the next render, and
// inside flushSync/act. Class lifecycle and useLayoutEffect stay in the layout
// phase (synchronous), so their observable timing is unchanged.

const pendingPassive: Fiber[] = [];
let passiveScheduled = false;
let flushingPassive = false;

function schedulePassiveFlush(): void {
  if (passiveScheduled) return;
  passiveScheduled = true;
  setTimeout(() => {
    passiveScheduled = false;
    flushPassiveEffects();
  }, 0);
}

/** Run all queued passive effects (useEffect). Safe to call repeatedly. */
export function flushPassiveEffects(): void {
  if (flushingPassive || pendingPassive.length === 0) return;
  flushingPassive = true;
  try {
    const batch = pendingPassive.splice(0);
    // All passive cleanups across the batch run before any passive setup — React's
    // two-pass order (commitPassiveUnmount then commitPassiveMount).
    runCommitEffects(batch, (f) => {
      const es = f.passiveEffects;
      f.passiveEffects = [];
      return es;
    });
  } finally {
    flushingPassive = false;
  }
}

/** Unmount a fiber subtree: lifecycle cleanups, ref detach, DOM removal. */
/**
 * Run a fiber's own unmount cleanups: the class lifecycle, then every hook cleanup. A
 * throwing cleanup must not strand the rest of the unmount (sibling cleanups, ref
 * detach, DOM removal). The subtree is being destroyed, so report rather than route to
 * a boundary within it.
 */
function runUnmountCleanups(fiber: Fiber): void {
  if (__DENEXT_CLASS_COMPONENTS__ && fiber.classInstance) unmountClassInstance(fiber as never);
  if (!fiber.hooks) return;
  for (const cell of fiber.hooks) {
    if (typeof cell.cleanup !== "function") continue;
    try {
      cell.cleanup();
    } catch (err) {
      console.error("denext: a cleanup threw during unmount", err);
    }
  }
}

/** Remove a host/text fiber's node from the DOM, if it is attached. */
function removeHostNode(fiber: Fiber): void {
  const dom = fiber.stateNode;
  if (dom && (fiber.tag === "host" || fiber.tag === "text") && dom.parentNode) {
    dom.parentNode.removeChild(dom);
  }
}

/**
 * Mark unmounted and sever tree links so that if anything outside the tree still
 * references this fiber (a pending Suspense retry promise), it can't pin the rest of
 * the detached subtree or the root in memory.
 */
function severFiber(fiber: Fiber): void {
  fiber.unmounted = true;
  if (fiber.alternate) fiber.alternate.unmounted = true;
  fiber.child = null;
  fiber.sibling = null;
  fiber.return = null;
  fiber.stateNode = null;
}

export function commitDeletion(fiber: Fiber): void {
  fiber.lanes = NoLane;
  if (fiber.alternate) fiber.alternate.lanes = NoLane;
  // Drop any not-yet-run passive effects so the scheduled flush never runs an
  // effect for an unmounted component (its cleanups run below via the hook cells).
  fiber.passiveEffects = undefined;
  // Destroy children BEFORE this fiber's own cleanups — React's unmount order is
  // child-before-parent, so a parent effect's cleanup can rely on its children's
  // having already run. Capture the next sibling before recursing, since we sever
  // links below, which would otherwise cut the traversal short.
  for (let c = fiber.child; c !== null;) {
    const next = c.sibling;
    commitDeletion(c);
    c = next;
  }
  if (fiber.tag === "component") runUnmountCleanups(fiber);
  if (fiber.attachedRef != null) detachRef(fiber);
  removeHostNode(fiber);
  severFiber(fiber);
}
