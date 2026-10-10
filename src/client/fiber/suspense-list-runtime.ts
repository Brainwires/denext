// The SuspenseList reveal runtime: wiring a list's shared reveal state onto its Fragment and
// deciding what each member <Suspense> shows. It ships only with `SuspenseList`: the list's
// element carries `applySuspenseListPolicy` in its marker prop (runtime/suspense.ts), and the
// state it wires carries `suspenseListDisplay`, so the always-shipped reconciler never imports
// this module and an app that never renders a SuspenseList bundles none of it.

import {
  type Fiber,
  fiberExt,
  hasBit,
  ShowingFallbackBit,
  type SuspenseListState,
} from "./fiber.ts";

/**
 * Wire a SuspenseList's shared reveal state onto a Fragment carrying the reveal-policy
 * marker, and tag its direct children with their membership + index (propagated one
 * level to the <Suspense> each renders). beginFragment calls it through the marker.
 */
export function applySuspenseListPolicy(
  wip: Fiber,
  listPolicy: Pick<SuspenseListState, "revealOrder" | "tail">,
): void {
  // One shared state object across all buffers (created once, carried by
  // reference) so a bailed/cloned member always reads fresh reveal state.
  const x = fiberExt(wip);
  const st: SuspenseListState = x.listState ??= { members: [], ready: [], snapshot: [] };
  st.revealOrder = listPolicy.revealOrder;
  st.tail = listPolicy.tail;
  st.display = suspenseListDisplay;
  // Freeze the persistent readiness so every member this render decides against
  // one consistent state, then start a fresh roster of scheduling targets.
  st.snapshot = [...st.ready];
  st.members = [];
  // Tag the list's direct children; membership propagates one level to the
  // <Suspense> each renders (see reconcileChildren).
  let i = 0;
  for (let c = wip.child; c !== null; c = c.sibling) {
    const cx = fiberExt(c);
    cx.listOwnerState = st;
    cx.listIndex = i++;
  }
  // Record the child count so the collapsed/hidden tail can locate the leading
  // boundary on the first render (when `snapshot` is still empty).
  st.count = i;
}

/**
 * Decide what a `<Suspense>` inside a `<SuspenseList>` shows this render: its
 * content, its fallback, or nothing (`tail`). A boundary is "revealed" only when
 * its own content is ready AND the boundaries before it (per `revealOrder`) are
 * too. Not-yet-ready boundaries render their content to drive their promise (and
 * suspend to a fallback); a resolved-but-order-gated boundary shows its fallback.
 * With `tail` collapsed/hidden only the leading edge renders (a serial tail).
 */
function suspenseListDisplay(member: Fiber): "content" | "fallback" | "hidden" {
  const st = member.ext!.listState!;
  const order = st.revealOrder!;
  // The frozen readiness snapshot for this render, so every member decides against
  // one consistent state.
  const ready = st.snapshot;
  const idx = member.ext!.listIndex!;
  const revealed = (i: number): boolean => {
    if (!ready[i]) return false;
    if (order === "together") return ready.length > 0 && ready.every(Boolean);
    if (order === "backwards") return ready.slice(i + 1).every(Boolean);
    return ready.slice(0, i).every(Boolean); // forwards
  };
  if (revealed(idx)) return "content";
  // A boundary not yet revealed shows its fallback. If it hasn't started/finished
  // its promise (not ready and not already suspended) it renders content once to
  // drive the promise — which then suspends back to its fallback.
  const gated = (): "content" | "fallback" =>
    !ready[idx] && !hasBit(member, ShowingFallbackBit) ? "content" : "fallback";
  if (st.tail === "collapsed" || st.tail === "hidden") {
    // Only the leading not-yet-revealed boundary renders; the rest wait, hidden.
    // Length comes from the child count (not `ready.length`, which is empty on the
    // first render before any member reports readiness).
    const n = st.count ?? ready.length;
    const order2 = Array.from({ length: n }, (_, i) => i);
    const seq = order === "backwards" ? order2.reverse() : order2;
    const leading = seq.find((i) => !revealed(i));
    if (idx !== leading) return "hidden";
    // Drive the leading boundary's promise. `"collapsed"` shows its fallback while
    // pending; `"hidden"` shows NO fallback (React parity) — it hides instead, so the
    // fetch still starts (the initial content-drive throws synchronously) but nothing
    // is painted for the pending tail.
    const g = gated();
    return g === "fallback" && st.tail === "hidden" ? "hidden" : g;
  }
  // Default tail: boundaries fetch in parallel.
  return gated();
}
