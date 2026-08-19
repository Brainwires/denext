// Component testing for denext — a Testing-Library-style `render` that mounts a
// component into an in-memory DOM with real hooks, effects, and events, plus
// queries and `fireEvent`. No browser, no third-party DOM.
//
// `render` (and `fireEvent`/`rerender`/`unmount`) are async because denext's `act`
// flushes effects on a microtask — `await` them so effects and state updates settle
// before you assert.

import { act, createRoot, type Root, setDocument } from "../client/mod.ts";
import type { VNode } from "../jsx/types.ts";
import {
  DomDocument,
  type DomEl,
  DomText,
  fireEventOn,
  type TestElement,
  walkElements,
} from "./dom.ts";

export type { TestElement } from "./dom.ts";
// `render` accepts a denext element (`h(...)` → VNode); re-export the VNode type
// graph so the public signature is self-contained. FRAGMENT is the symbol
// `VNodeType` admits for fragments.
export { FRAGMENT } from "../jsx/types.ts";
export type {
  Component,
  Key,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "../jsx/types.ts";

/** A text matcher: an exact/normalized string, or a regular expression. */
export type TextMatch = string | RegExp;

/** Options controlling text matching. */
export interface MatchOptions {
  /** Exact, whitespace-normalized equality (default `true`). `false` = substring. */
  exact?: boolean;
}

/** Options for {@linkcode Queries.getByRole}. */
export interface RoleOptions {
  /** Filter by accessible name (aria-label, text content, or value). */
  name?: TextMatch;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

function textMatches(match: TextMatch, text: string, opts: MatchOptions = {}): boolean {
  if (match instanceof RegExp) return match.test(text);
  const a = norm(text);
  const b = norm(match);
  return opts.exact === false ? a.includes(b) : a === b;
}

/** The direct text of an element (its text-node children only), normalized. */
function ownText(el: DomEl): string {
  return norm(
    el.childNodes.filter((n): n is DomText => n instanceof DomText).map((n) => n.nodeValue).join(
      "",
    ),
  );
}

const INPUT_TEXTBOX = new Set(["text", "email", "search", "url", "tel", ""]);

/** Implicit ARIA role of an element (a small, common subset), or its explicit role. */
function roleOf(el: DomEl): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  switch (el.tagName) {
    case "BUTTON":
      return "button";
    case "A":
    case "AREA":
      return el.hasAttribute("href") ? "link" : null;
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "heading";
    case "INPUT":
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return INPUT_TEXTBOX.has(type) ? "textbox" : null;
    case "TEXTAREA":
      return "textbox";
    case "SELECT":
      return "combobox";
    case "IMG":
      return el.hasAttribute("alt") ? "img" : null;
    case "UL":
    case "OL":
      return "list";
    case "LI":
      return "listitem";
    case "NAV":
      return "navigation";
    default:
      return null;
  }
}

/** The accessible name used by role queries (aria-label, then text, then value). */
function accessibleName(el: DomEl): string {
  return norm(el.getAttribute("aria-label") ?? el.textContent ?? el.value ?? "");
}

/** Throw with a Testing-Library-style message for a failed `getBy`/`getAllBy`. */
function found(matches: DomEl[], desc: string, expectOne: boolean): DomEl[] {
  if (matches.length === 0) throw new Error(`Unable to find an element ${desc}.`);
  if (expectOne && matches.length > 1) {
    throw new Error(`Found ${matches.length} elements ${desc} (expected 1).`);
  }
  return matches;
}

/** The query methods bound to a rendered container. */
export interface Queries {
  /** All elements whose own text matches. */
  getAllByText(match: TextMatch, opts?: MatchOptions): TestElement[];
  /** The single element whose own text matches (throws if 0 or >1). */
  getByText(match: TextMatch, opts?: MatchOptions): TestElement;
  /** The single element whose own text matches, or `null` if none. */
  queryByText(match: TextMatch, opts?: MatchOptions): TestElement | null;
  /** All elements with the given ARIA role (optionally filtered by name). */
  getAllByRole(role: string, opts?: RoleOptions): TestElement[];
  /** The single element with the given ARIA role (throws if 0 or >1). */
  getByRole(role: string, opts?: RoleOptions): TestElement;
  /** The single element with the given ARIA role, or `null`. */
  queryByRole(role: string, opts?: RoleOptions): TestElement | null;
  /** The form control associated with a `<label>` whose text matches. */
  getByLabelText(match: TextMatch, opts?: MatchOptions): TestElement;
  /** The form control for a matching label, or `null`. */
  queryByLabelText(match: TextMatch, opts?: MatchOptions): TestElement | null;
  /** The element carrying `placeholder` matching `match`. */
  getByPlaceholderText(match: TextMatch, opts?: MatchOptions): TestElement;
  /** The element with `data-testid` equal to `id`. */
  getByTestId(id: string): TestElement;
  /** The element with `data-testid` equal to `id`, or `null`. */
  queryByTestId(id: string): TestElement | null;
}

function makeQueries(root: DomEl): Queries {
  const all = () => walkElements(root);
  const byText = (m: TextMatch, o?: MatchOptions) =>
    all().filter((el) => textMatches(m, ownText(el), o));
  const byRole = (role: string, o?: RoleOptions) =>
    all().filter((el) =>
      roleOf(el) === role && (!o?.name || textMatches(o.name, accessibleName(el)))
    );
  const labelControl = (m: TextMatch, o?: MatchOptions): DomEl[] => {
    const controls: DomEl[] = [];
    for (const label of all().filter((el) => el.tagName === "LABEL")) {
      if (!textMatches(m, norm(label.textContent), o)) continue;
      const htmlFor = label.getAttribute("for");
      if (htmlFor) {
        const target = all().find((el) => el.getAttribute("id") === htmlFor);
        if (target) controls.push(target);
      } else {
        const nested = walkElements(label).find((el) =>
          ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && el !== label
        );
        if (nested) controls.push(nested);
      }
    }
    return controls;
  };
  const byPlaceholder = (m: TextMatch, o?: MatchOptions) =>
    all().filter((el) => {
      const p = el.getAttribute("placeholder");
      return p !== null && textMatches(m, p, o);
    });
  const byTestId = (id: string) => all().filter((el) => el.getAttribute("data-testid") === id);

  return {
    getAllByText: (m, o) => found(byText(m, o), `with text ${m}`, false),
    getByText: (m, o) => found(byText(m, o), `with text ${m}`, true)[0],
    queryByText: (m, o) => byText(m, o)[0] ?? null,
    getAllByRole: (r, o) => found(byRole(r, o), `with role "${r}"`, false),
    getByRole: (r, o) => found(byRole(r, o), `with role "${r}"`, true)[0],
    queryByRole: (r, o) => byRole(r, o)[0] ?? null,
    getByLabelText: (m, o) => found(labelControl(m, o), `for label ${m}`, true)[0],
    queryByLabelText: (m, o) => labelControl(m, o)[0] ?? null,
    getByPlaceholderText: (m, o) => found(byPlaceholder(m, o), `with placeholder ${m}`, true)[0],
    getByTestId: (id) => found(byTestId(id), `with data-testid "${id}"`, true)[0],
    queryByTestId: (id) => byTestId(id)[0] ?? null,
  };
}

/** A dispatched-event helper: callable, plus named shortcuts. All are async. */
export interface FireEvent {
  /** Dispatch an arbitrary event type on `el`, then flush. */
  (el: TestElement, type: string, init?: Record<string, unknown>): Promise<void>;
  /** Click `el`. */
  click(el: TestElement, init?: Record<string, unknown>): Promise<void>;
  /** Fire an `input` event, setting `el.value` from `init.target.value` first. */
  input(el: TestElement, init?: { target?: { value?: string } }): Promise<void>;
  /**
   * Trigger an `onChange` handler, setting `el.value` from `init.target.value`
   * first. denext (like React) wires `onChange` to the DOM **`input`** event, so
   * this dispatches `input` — use it for controlled inputs.
   */
  change(el: TestElement, init?: { target?: { value?: string } }): Promise<void>;
  /** Submit `el` (a form). */
  submit(el: TestElement, init?: Record<string, unknown>): Promise<void>;
  /** Fire a `keydown` (e.g. `{ key: "Enter" }`). */
  keyDown(el: TestElement, init?: Record<string, unknown>): Promise<void>;
}

async function dispatch(
  el: TestElement,
  type: string,
  init: Record<string, unknown> = {},
): Promise<void> {
  const target = el as DomEl;
  // Reflect a provided value onto the element so controlled handlers reading
  // `e.target.value` see it (input/change semantics).
  const valued = init as { target?: { value?: string } };
  if (valued.target?.value !== undefined) target.value = valued.target.value;
  await act(() => fireEventOn(target, type, { ...init, target }));
}

/** Dispatch DOM events at rendered elements (bubbling), each wrapped in `act`. */
const fireEvent = Object.assign(
  (el: TestElement, type: string, init?: Record<string, unknown>) => dispatch(el, type, init),
  {
    click: (el: TestElement, init?: Record<string, unknown>) => dispatch(el, "click", init),
    input: (el: TestElement, init?: { target?: { value?: string } }) => dispatch(el, "input", init),
    // onChange is wired to the DOM `input` event in denext/React — dispatch that.
    change: (el: TestElement, init?: { target?: { value?: string } }) =>
      dispatch(el, "input", init),
    submit: (el: TestElement, init?: Record<string, unknown>) => dispatch(el, "submit", init),
    keyDown: (el: TestElement, init?: Record<string, unknown>) => dispatch(el, "keydown", init),
  },
) as FireEvent;

export { fireEvent };

/** The handle returned by {@linkcode render}. */
export interface RenderResult extends Queries {
  /** The container element the component was mounted into. */
  container: TestElement;
  /** Dispatch events (bound to this render). */
  fireEvent: FireEvent;
  /** Re-render with new element(s); flushes before resolving. */
  rerender(ui: VNode): Promise<void>;
  /** Unmount the component (runs cleanup effects). */
  unmount(): Promise<void>;
  /** Run `fn` inside `act` and flush effects/state. */
  act(fn: () => void | Promise<void>): Promise<void>;
  /** The container's current inner HTML (for debugging/snapshotting). */
  html(): string;
}

/**
 * Mount `ui` into a fresh in-memory DOM and return queries + interaction helpers.
 * Effects run (wrapped in `act`), so `await` the call before asserting.
 *
 * ```ts
 * const screen = await render(h(Counter, null));
 * await screen.fireEvent.click(screen.getByRole("button"));
 * assertEquals(screen.getByRole("button").textContent, "Clicked 1");
 * ```
 *
 * @param ui The element to render (e.g. `h(Component, props)`).
 * @returns A {@linkcode RenderResult}.
 */
export async function render(ui: VNode): Promise<RenderResult> {
  const doc = new DomDocument();
  const container = doc.createElement("div");
  setDocument(doc as unknown as Parameters<typeof setDocument>[0]);
  const root: Root = createRoot(container as unknown as Parameters<typeof createRoot>[0]);
  await act(() => {
    root.render(ui);
  });
  const queries = makeQueries(container);
  return {
    container,
    ...queries,
    fireEvent,
    rerender: (next) => act(() => root.render(next)).then(() => {}),
    unmount: () => act(() => root.unmount()).then(() => {}),
    act: (fn) => act(fn).then(() => {}),
    html: () => container.innerHTML,
  };
}
