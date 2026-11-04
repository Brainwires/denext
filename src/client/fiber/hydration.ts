// Hydration: claiming server-rendered DOM nodes for host and text fibers as the first
// hydrateRoot render walks them, plus the mismatch diagnostics.

import { rootHandleOf } from "./state.ts";
import { componentErrorInfo, devHydrationActive } from "./fiber-utils.ts";
import { safeCallback } from "./root-callbacks.ts";
import { type Cursor, type Fiber, Placement } from "./fiber.ts";
import { doc } from "./state.ts";
import { TEXT_TYPE } from "../vnode-utils.ts";
import { getSingletonSupport } from "./singleton-support.ts";

// Hydration state: a live cursor over server-rendered DOM during the first hydrateRoot
// render. `hydrationStack` mirrors the recursive reconciler's per-host child cursors;
// push on entering a host (claimHost), pop on completing it (popHydrationCursor).
export let isHydrating = false;
let hydrationCursor: Cursor | null = null;
let hydrationStack: (Cursor | null)[] = [];

/**
 * Start adopting `container`'s server DOM (the first hydrateRoot render). `startNode`, when
 * given, seeds the cursor at that child instead of the first — used by document-root hydration
 * to begin at `<html>` and skip the leading doctype/comment nodes.
 */
export function beginHydration(container: Node, startNode?: Node | null): void {
  isHydrating = true;
  const index = startNode
    ? Math.max(Array.prototype.indexOf.call(container.childNodes, startNode), 0)
    : 0;
  hydrationCursor = { parent: container, index };
  hydrationStack = [];
}

export function endHydration(): void {
  isHydrating = false;
  hydrationCursor = null;
  islandRoot = null;
}

/** Leaving a host: restore the parent's cursor that claimHost pushed (and end an island's). */
export function popHydrationCursor(wip: Fiber): void {
  hydrationCursor = hydrationStack.pop() ?? null;
  if (wip === islandRoot) endHydration();
}

/** The island wrapper whose children are hydrating after the page did (see iso-island.ts). */
let islandRoot: Fiber | null = null;

/**
 * Hydrate `wip`'s children against the server DOM it kept while the page hydrated around it: an
 * isomorphic island turning live in a later render. Ends when `wip` completes.
 */
export function hydrateChildrenOf(wip: Fiber): void {
  isHydrating = true;
  islandRoot = wip;
  hydrationStack.push(hydrationCursor);
  hydrationCursor = { parent: wip.stateNode as Element, index: 0 };
}

/**
 * The isomorphic island runtime's begin hook for a host outside hydration (iso-island.ts), or
 * null when no page has loaded it.
 */
let islandHydration: ((wip: Fiber) => void) | null = null;

/** Install (or clear) {@link islandHydration}. */
export function setIslandHydration(fn: ((wip: Fiber) => void) | null): void {
  islandHydration = fn;
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
  if (!devHydrationActive()) return;
  console.warn(
    `denext: hydration mismatch — ${detail}. The client render is used; ` +
      `check for output that differs between server and client (Date.now(), ` +
      `Math.random(), locale/timezone, or invalid HTML nesting).`,
  );
}

/** Entering a host: claim its server node while hydrating, else let an island hydrate (iso-island.ts). */
export function beginHostHydration(wip: Fiber): void {
  if (isHydrating) claimHost(wip);
  else islandHydration?.(wip);
}

/**
 * The server node at the hydration cursor (null past the end, or with no cursor). Server
 * markup the client tree has no node for is passed over, as React's hydration does: a
 * comment (a Suspense boundary's `<!--$-->` / `<!--/$-->` markers, a PPR hole's markers),
 * and a streamed Suspense boundary's `<div data-dnx-b>` placeholder, which is unwrapped in
 * place — its children (the revealed content) moved up into its position — so the content
 * hydrates where a boundary rendered inline would have put it.
 */
export function cursorNode(): Node | null {
  const cursor = hydrationCursor;
  if (!cursor) return null;
  for (;;) {
    const node = cursor.parent.childNodes[cursor.index] ?? null;
    if (node === null) return null;
    if (node.nodeType === 8) cursor.index++;
    else if (isBoundaryPlaceholder(node)) unwrap(node as Element);
    else return node;
  }
}

/**
 * The client-rendered boundary step (suspense-hydration.ts): given a Suspense fiber entering
 * (`true`) or completing, and the cursor, the cursor to continue with. Only react-dom/server's
 * synchronous `renderToString` writes such a boundary (`<!--$!-->`), so the compat
 * `react-dom/client` / `react-dom` install it; denext's own renderers never do.
 */
let suspenseHydration:
  | ((wip: Fiber, cursor: Cursor | null, entering: boolean) => Cursor | null)
  | null = null;

/** Install {@link suspenseHydration}. */
export function setSuspenseHydration(
  fn: (wip: Fiber, cursor: Cursor | null, entering: boolean) => Cursor | null,
): void {
  suspenseHydration = fn;
}

/** Entering (`true`) or completing a Suspense fiber: a `<!--$!-->` boundary renders client-side. */
export function suspenseHydrationStep(wip: Fiber, entering: boolean): void {
  if (suspenseHydration) hydrationCursor = suspenseHydration(wip, hydrationCursor, entering);
}

/** A streamed Suspense boundary's placeholder (`<div data-dnx-b="id">`). */
function isBoundaryPlaceholder(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).getAttribute?.("data-dnx-b") != null;
}

/** Replace `el` by its own children, which keep their identity (nothing is re-created). */
function unwrap(el: Element): void {
  const parent = el.parentNode!;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function claimHost(wip: Fiber): void {
  const tag = wip.vnode.type as string;
  // A client root layout's head tag, which the server hoisted into the page's head: claimed
  // there by match (null: none, so it mounts fresh), never from the container's cursor.
  const hoisted = getSingletonSupport()?.claimHoisted(wip);
  const existing = hoisted !== undefined ? hoisted : cursorNode();
  const matches = existing !== null && existing.nodeType === 1 &&
    (existing as Element).tagName.toLowerCase() === tag.toLowerCase();
  if (matches) {
    wip.stateNode = existing as Element;
    if (hoisted === undefined) hydrationCursor!.index++;
    hydrationStack.push(hydrationCursor);
    hydrationCursor = { parent: existing as Element, index: 0 };
  } else {
    if (hydrationCursor && hoisted === undefined) {
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
  const existing = cursorNode();
  if (existing && existing.nodeType === 3) adoptServerText(wip, existing as Text, value);
  else placeFreshText(wip, value, existing);
}

/**
 * The props an adopted host's markup already reflects, for its first `applyProps` (null: none).
 * An adopted `dangerouslySetInnerHTML` host keeps the server's inner HTML — the very nodes the
 * parser built, never cleared or re-created — so its prop reads as already applied. As in React
 * 19, a server markup that differs from `__html` is kept too, never patched: development warns
 * ({@link installHydrationWarning}); production carries no comparison at all.
 */
export function adoptServerHtml(
  wip: Fiber,
  el: Element,
  value: { __html?: unknown } | undefined,
): Record<string, unknown> | null {
  if (value === undefined) return null;
  checkServerHtml?.(wip, el, value.__html);
  return { dangerouslySetInnerHTML: value };
}

/** Dev only: the `__html` comparison {@link adoptServerHtml} runs (installed with the warning). */
let checkServerHtml: ((wip: Fiber, el: Element, html: unknown) => void) | null = null;

/**
 * React 19's dev check (`diffHydratedProperties`): `__html` parsed (so mere re-serialization,
 * `<br/>` vs `<br>`, is no difference) against the server's inner
 * HTML. A difference is a `console.error` that says it won't be patched up — not an
 * `onRecoverableError`, which React keeps for mismatches it recovers from by re-rendering —
 * and `suppressHydrationWarning` on the element silences it.
 */
function warnServerHtml(wip: Fiber, el: Element, html: unknown): void {
  if (typeof html !== "string" || !devHydrationActive() || suppressed(wip)) return;
  const server = el.innerHTML;
  if (server === html) return;
  // Parsed into an inert <template>: markup parsed into an element of the live document loads
  // its images and runs their `onerror` / `onload`, even while the element is detached.
  const probe = (el.ownerDocument ?? doc).createElement("template");
  probe.innerHTML = html;
  if (probe.innerHTML === server) return;
  console.error(
    `denext: hydration mismatch — <${el.tagName.toLowerCase()}>'s dangerouslySetInnerHTML ` +
      `differs from the server's markup. This won't be patched up: the server's markup is ` +
      `kept, as React keeps it. Render the same __html on the server and the client.`,
  );
}

/**
 * Report a recovered error (`onRecoverableError`) — currently a hydration mismatch,
 * where denext keeps the client render. Fires the callback if registered (any env),
 * else falls back to the dev-only console warning.
 */
/**
 * Whether the nearest host element above `fiber` opted out of the warning with React's
 * `suppressHydrationWarning` — one level, like React: the element's own text content and
 * attributes are exempt, its descendants are not.
 */
function suppressed(fiber: Fiber): boolean {
  let f: Fiber | null = fiber;
  while (f !== null && (typeof f.vnode?.type !== "string" || f.vnode.type === TEXT_TYPE)) {
    f = f.return;
  }
  return f !== null && f.vnode.props?.suppressHydrationWarning === true;
}

function reportHydrationMismatch(fiber: Fiber, detail: string): void {
  if (suppressed(fiber)) return;
  const cb = rootHandleOf(fiber)?.onRecoverableError;
  if (cb) safeCallback(cb, new Error(`Hydration failed: ${detail}`), componentErrorInfo(fiber));
  else warnMismatch?.(detail);
}

/**
 * Dev only: the console warning for a mismatch no `onRecoverableError` took. Installed by the
 * dev entries ({@linkcode installHydrationWarning}, via `installDevtools`), so a production
 * bundle carries neither the message nor the check; the report pays one `?.`.
 */
let warnMismatch: ((detail: string) => void) | null = null;

/** Install (or, with `false`, remove) the dev-only hydration-mismatch warning. */
export function installHydrationWarning(on = true): void {
  warnMismatch = on ? warnHydrationMismatch : null;
  checkServerHtml = on ? warnServerHtml : null;
}
