// Hydration: claiming server-rendered DOM nodes for host and text fibers as the first
// hydrateRoot render walks them, plus the mismatch diagnostics.

import { rootHandleOf } from "./state.ts";
import { componentErrorInfo, devHydrationActive } from "./fiber-utils.ts";
import { safeCallback } from "./root-callbacks.ts";
import { type Cursor, type Fiber, Placement } from "./fiber.ts";
import { doc } from "./state.ts";

// Hydration state: a live cursor over server-rendered DOM during the first hydrateRoot
// render. `hydrationStack` mirrors the recursive reconciler's per-host child cursors;
// push on entering a host (claimHost), pop on completing it (popHydrationCursor).
export let isHydrating = false;
let hydrationCursor: Cursor | null = null;
let hydrationStack: (Cursor | null)[] = [];

/** Start adopting `container`'s server DOM (the first hydrateRoot render). */
export function beginHydration(container: Element): void {
  isHydrating = true;
  hydrationCursor = { parent: container, index: 0 };
  hydrationStack = [];
}

export function endHydration(): void {
  isHydrating = false;
  hydrationCursor = null;
}

/** Leaving a host: restore the parent's cursor that claimHost pushed. */
export function popHydrationCursor(): void {
  hydrationCursor = hydrationStack.pop() ?? null;
}

/** Stop adopting server DOM below this point (e.g. a fallback must mount fresh). */
export function dropHydrationCursor(): void {
  hydrationCursor = null;
}

function describeNode(node: Node | null): string {
  if (!node) return "nothing (the server markup ended early)";
  if (node.nodeType === 3) return `text ${JSON.stringify(node.nodeValue ?? "")}`;
  if (node.nodeType === 1) return `<${(node as Element).tagName.toLowerCase()}>`;
  return `a node of type ${node.nodeType}`;
}

function warnHydrationMismatch(detail: string): void {
  console.warn(
    `denext: hydration mismatch — ${detail}. The client render is used; ` +
      `check for output that differs between server and client (Date.now(), ` +
      `Math.random(), locale/timezone, or invalid HTML nesting).`,
  );
}

export function claimHost(wip: Fiber): void {
  const tag = wip.vnode.type as string;
  const existing = hydrationCursor
    ? (hydrationCursor.parent.childNodes[hydrationCursor.index] ?? null)
    : null;
  const matches = existing !== null && existing.nodeType === 1 &&
    (existing as Element).tagName.toLowerCase() === tag.toLowerCase();
  if (matches) {
    wip.stateNode = existing as Element;
    hydrationCursor!.index++;
    hydrationStack.push(hydrationCursor);
    hydrationCursor = { parent: existing as Element, index: 0 };
  } else {
    if (hydrationCursor) {
      reportHydrationMismatch(
        wip,
        `expected <${tag.toLowerCase()}>, but the server rendered ${describeNode(existing)}`,
      );
    }
    hydrationStack.push(hydrationCursor);
    hydrationCursor = null; // subtree mounts fresh
  }
}

/**
 * Adopt the server text node at the hydration cursor for `wip`'s text vnode. A server
 * value that merely STARTS with this vnode's value is adjacent-text coalescing: adopt
 * this vnode's slice and split the remainder into a new node for the next text vnode to
 * adopt — not a mismatch. Anything else that differs is a mismatch, reported and
 * overwritten.
 */
function adoptServerText(wip: Fiber, node: Text, value: string): void {
  const serverValue = node.nodeValue ?? "";
  if (serverValue !== value) {
    if (value !== "" && serverValue.length > value.length && serverValue.startsWith(value)) {
      node.nodeValue = value;
      const remainder = doc.createTextNode(serverValue.slice(value.length));
      hydrationCursor!.parent.insertBefore(
        remainder,
        hydrationCursor!.parent.childNodes[hydrationCursor!.index + 1] ?? null,
      );
    } else {
      reportHydrationMismatch(
        wip,
        `server text ${JSON.stringify(serverValue)} became ${JSON.stringify(value)}`,
      );
      node.nodeValue = value;
    }
  }
  hydrationCursor!.index++;
  wip.stateNode = node;
}

/** No adoptable text at the cursor: report the mismatch (when hydrating) and create a fresh node. */
function placeFreshText(wip: Fiber, value: string, existing: Node | null): void {
  if (hydrationCursor) {
    reportHydrationMismatch(
      wip,
      `expected text ${JSON.stringify(value)}, but the server rendered ${describeNode(existing)}`,
    );
  }
  wip.stateNode = doc.createTextNode(value);
  wip.flags |= Placement;
}

export function claimText(wip: Fiber): void {
  const value = String(wip.vnode.props.nodeValue ?? "");
  const existing = hydrationCursor
    ? (hydrationCursor.parent.childNodes[hydrationCursor.index] ?? null)
    : null;
  if (existing && existing.nodeType === 3) adoptServerText(wip, existing as Text, value);
  else placeFreshText(wip, value, existing);
}

/**
 * Report a recovered error (`onRecoverableError`) — currently a hydration mismatch,
 * where denext keeps the client render. Fires the callback if registered (any env),
 * else falls back to the dev-only console warning.
 */
function reportHydrationMismatch(fiber: Fiber, detail: string): void {
  const cb = rootHandleOf(fiber)?.onRecoverableError;
  if (cb) safeCallback(cb, new Error(`Hydration failed: ${detail}`), componentErrorInfo(fiber));
  else if (devHydrationActive()) warnHydrationMismatch(detail);
}
