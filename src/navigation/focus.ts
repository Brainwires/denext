/**
 * Focus on navigation for `denext/navigation`'s stacks: when a push or a pop shows a screen,
 * keyboard and screen reader focus moves into it, as VoiceOver and TalkBack move to a native
 * screen. A push focuses the new screen's first heading (its header title), else the screen
 * itself; a pop gives focus back to the element that had it when the screen was left (the
 * button that opened the next one). The first screen takes no focus, and focus elsewhere on the
 * page (a field beside the stack) is left where it is. A tab switch keeps focus on the tab, as
 * the platforms and the ARIA tabs pattern do.
 *
 * @module
 */

/** The slice of a DOM node the focus move walks. */
export interface FocusNode {
  readonly nodeType?: number;
  readonly tagName?: string;
  readonly parentNode?: FocusNode | null;
  readonly childNodes?: ArrayLike<FocusNode>;
  readonly ownerDocument?: { readonly activeElement?: unknown; readonly body?: unknown } | null;
  readonly isConnected?: boolean;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
  setAttribute?(name: string, value: string): void;
  focus?(options?: { preventScroll?: boolean }): void;
}

/** Whether `node` is `root` or inside it. */
function within(root: FocusNode, node: FocusNode | null | undefined): boolean {
  for (let n = node; n; n = n.parentNode) if (n === root) return true;
  return false;
}

/** The first heading inside `el` (an `h1`–`h6` or `role="heading"`), in document order. */
function firstHeading(el: FocusNode): FocusNode | null {
  const kids = el.childNodes ?? [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.nodeType !== 1) continue;
    if (c.getAttribute?.("role") === "heading" || /^H[1-6]$/.test(c.tagName ?? "")) return c;
    const found = firstHeading(c);
    if (found) return found;
  }
  return null;
}

/**
 * Move focus into a screen that a navigation just showed, the way VoiceOver and TalkBack move
 * to a native screen: to the screen's first heading (its header title), else the screen itself,
 * made focusable with `tabindex="-1"` when it isn't. `restore` (the element focused when the
 * screen was left) wins when it is still inside. Exported for testing.
 *
 * @param screen The shown screen's element.
 * @param restore The element to give focus back to, on a return to the screen.
 * @returns The element focused.
 */
export function focusScreen(screen: FocusNode, restore?: FocusNode | null): FocusNode {
  const back = restore && within(screen, restore) ? restore : null;
  const target = back ?? firstHeading(screen) ?? screen;
  if (!back && target.hasAttribute?.("tabindex") === false) {
    target.setAttribute?.("tabindex", "-1");
  }
  target.focus?.({ preventScroll: true });
  return target;
}

/**
 * Whether a navigation inside `root` may move focus: nothing is focused (the body, or an element
 * no longer in the document), or the focus is inside `root`. Focus elsewhere on the page (a search field beside the stack) stays.
 */
export function mayMoveFocus(root: FocusNode): boolean {
  const doc = root.ownerDocument;
  const active = doc?.activeElement as FocusNode | null | undefined;
  // A focused element the navigation removed leaves nothing focused.
  return !active || active === doc?.body || active.isConnected === false || within(root, active);
}

/** What a stack's focus move reads (see {@linkcode stackFocusMove}). */
export interface StackFocusChange {
  /** The stack's container. */
  readonly root: FocusNode | null;
  /** The new top screen's section. */
  readonly section: FocusNode | undefined;
  /** The ids of the screens now in the stack. */
  readonly ids: ReadonlySet<string>;
  /** The screen that was on top. */
  readonly prev: string;
  /** The screen now on top. */
  readonly top: string;
  /** Whether the new top is a form sheet (which manages its own focus). */
  readonly sheet: boolean;
  /** The element focused when each screen still in the stack was pushed over (kept current). */
  readonly saved: Map<string, FocusNode>;
}

/** The focused element of `root`'s document, unless that is the body or nothing. */
function focusedIn(root: FocusNode): FocusNode | null {
  const doc = root.ownerDocument;
  const active = doc?.activeElement as FocusNode | null | undefined;
  return active && active !== doc?.body ? active : null;
}

/**
 * A stack's top changed from `prev` to `top`: remember where focus was on a push, forget the
 * screens that left, and focus the new top (see {@linkcode focusScreen}). Exported for testing.
 *
 * @param change The change.
 */
export function stackFocusMove(change: StackFocusChange): void {
  const { root, section, saved } = change;
  if (!root || !section || !mayMoveFocus(root)) return;
  const active = focusedIn(root);
  if (change.ids.has(change.prev) && active) saved.set(change.prev, active);
  for (const id of [...saved.keys()]) if (!change.ids.has(id)) saved.delete(id);
  if (change.sheet) return;
  focusScreen(section, saved.get(change.top));
  saved.delete(change.top);
}
