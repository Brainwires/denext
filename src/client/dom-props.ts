// Shared DOM prop/attribute/event/ref application, used by both the recursive
// reconciler and the fiber reconciler. Every function takes the target element
// explicitly plus a small mutable {@link HostState} bag (listeners + the attached
// ref and its cleanup), so it works against either reconciler's node type. Event
// and form-action handlers route thrown/rejected errors through an injected
// `onError` callback, keeping error-boundary routing renderer-specific.

import { isValidAttrName } from "../jsx/render-to-string.ts";
import { beginFormAction, endFormAction, type FormStatusSignal } from "../runtime/form-status.ts";

/** The mutable host bookkeeping both reconcilers' node types satisfy. */
export interface HostState {
  /** Attached event listeners, keyed by React prop name. */
  listeners?: Map<string, EventListener>;
  /** The ref currently attached to this element. */
  attachedRef?: unknown;
  /** The cleanup a React-19 callback ref returned (invoked on change/unmount). */
  refCleanup?: (() => void) | void;
  /** For a `<form action={fn}>`: the form-scoped pending signal (useFormStatus). */
  formStatus?: FormStatusSignal;
}

/** Routes an error thrown by an event/form-action handler to a boundary. */
export type ErrorRouter = (error: unknown) => void;

export function applyProps(
  el: Element,
  state: HostState,
  oldProps: Record<string, unknown>,
  newProps: Record<string, unknown>,
  onError: ErrorRouter,
): void {
  // Remove props gone or changed.
  for (const name of Object.keys(oldProps)) {
    if (name === "children" || name === "key" || name === "ref") continue;
    if (name in newProps) continue;
    if (/^on[A-Z]/.test(name)) {
      removeListener(el, state, name);
    } else if (
      (name === "action" || name === "formAction") && typeof oldProps[name] === "function"
    ) {
      // A function-valued form action wired a "submit" listener (setFormAction);
      // dropping the prop must remove that listener, not just the attribute.
      const existing = state.listeners?.get("submit");
      if (existing) {
        el.removeEventListener("submit", existing);
        state.listeners!.delete("submit");
      }
    } else {
      const attr = normalizeAttr(name);
      if (isValidAttrName(attr)) el.removeAttribute(attr);
    }
  }

  // Refs: attach/detach with React-19 semantics (support cleanup-returning
  // callback refs; detach the old ref when it changes). Handled outside the loop
  // so we can compare the previous and next ref.
  updateRef(state, oldProps.ref, newProps.ref, el);

  for (const [name, value] of Object.entries(newProps)) {
    if (name === "children" || name === "key" || name === "ref") continue;
    if (/^on[A-Z]/.test(name)) {
      setListener(el, state, name, value as EventListener | undefined, onError);
      continue;
    }
    // A form `action={fn}` (React 19 form action / useActionState dispatch):
    // intercept submit and call the action with the form's FormData.
    if (
      (name === "action" || name === "formAction") && typeof value === "function"
    ) {
      setFormAction(el, state, value as (payload: unknown) => void, onError);
      continue;
    }
    if (typeof value === "function") continue; // non-event function props aren't attrs
    if (oldProps[name] === value) continue;
    setAttribute(el, name, value);
  }
}

/** Wire a function-valued form `action` to the form's submit event. */
export function setFormAction(
  el: Element,
  state: HostState,
  action: (payload: unknown) => void,
  onError: ErrorRouter,
): void {
  const existing = state.listeners!.get("submit");
  if (existing) el.removeEventListener("submit", existing);
  const handler: EventListener = (event) => {
    event.preventDefault();
    const form = event.target;
    // Build FormData from the real form element when possible.
    const FormDataCtor = (globalThis as { FormData?: unknown }).FormData as
      | (new (form: unknown) => unknown)
      | undefined;
    let payload: unknown;
    try {
      payload = FormDataCtor && form ? new FormDataCtor(form) : undefined;
    } catch {
      payload = undefined; // non-form element (e.g. test shim)
    }
    // Drive the form-scoped pending signal (useFormStatus) for the duration of
    // the action, and route thrown/rejected errors to the nearest boundary.
    const sig = state.formStatus;
    if (sig) beginFormAction(sig);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (sig) endFormAction(sig);
    };
    try {
      const r = action(payload) as unknown;
      if (r && typeof (r as { then?: unknown }).then === "function") {
        (r as Promise<unknown>).then(done, (err) => {
          done();
          onError(err);
        });
      } else {
        done(); // synchronous action: already finished
      }
    } catch (err) {
      done();
      onError(err);
    }
  };
  el.addEventListener("submit", handler);
  state.listeners!.set("submit", handler);
}

/**
 * Attach `newRef` to `el` and detach `oldRef`, following React 19 ref semantics:
 * a callback ref may return a cleanup function (invoked on detach instead of
 * calling the ref with `null`); object refs get `.current` set/cleared. No-ops
 * when the ref is unchanged, so the same ref stays attached across re-renders.
 */
export function updateRef(state: HostState, oldRef: unknown, newRef: unknown, el: Element): void {
  if (Object.is(oldRef, newRef)) return;
  detachRef(state);
  if (newRef == null) return;
  if (typeof newRef === "function") {
    const cleanup = newRef(el);
    state.refCleanup = typeof cleanup === "function" ? cleanup : undefined;
  } else if (typeof newRef === "object") {
    (newRef as { current: unknown }).current = el;
  }
  state.attachedRef = newRef;
}

/** Detach the ref currently attached to `state` (cleanup fn, or clear/null it). */
export function detachRef(state: HostState): void {
  const ref = state.attachedRef;
  if (ref == null) return;
  if (typeof state.refCleanup === "function") {
    state.refCleanup();
  } else if (typeof ref === "function") {
    ref(null);
  } else if (typeof ref === "object") {
    (ref as { current: unknown }).current = null;
  }
  state.refCleanup = undefined;
  state.attachedRef = undefined;
}

/**
 * React's event-prop names don't always match DOM event types. Map the ones that
 * differ (keyed by the lowercased React name, minus `on`/`Capture`): React's
 * `onChange` is the DOM **`input`** event (fires per keystroke, not on blur), and
 * `onDoubleClick` is `dblclick`. Everything else lowercases directly.
 */
export const REACT_EVENT_MAP: Record<string, string> = {
  change: "input",
  doubleclick: "dblclick",
};

interface ParsedEvent {
  /** The DOM event type to (un)register. */
  type: string;
  /** Whether this is a capture-phase handler (`on*Capture`). */
  capture: boolean;
}

/** Parse an `on*` prop into its DOM event type and capture flag. */
export function parseEvent(prop: string): ParsedEvent {
  let name = prop.slice(2); // strip "on"
  let capture = false;
  if (name.endsWith("Capture")) {
    capture = true;
    name = name.slice(0, -"Capture".length);
  }
  const lower = name.toLowerCase();
  return { type: REACT_EVENT_MAP[lower] ?? lower, capture };
}

export function setListener(
  el: Element,
  state: HostState,
  prop: string,
  handler: EventListener | undefined,
  onError: ErrorRouter,
): void {
  const ev = parseEvent(prop);
  const key = prop; // key by React prop name so distinct props never collide
  const existing = state.listeners!.get(key);
  if (existing) el.removeEventListener(ev.type, existing, ev.capture);
  if (typeof handler === "function") {
    // Wrap so a throw in the handler routes to the nearest error boundary
    // (React can't catch event-handler errors; denext can).
    const wrapped: EventListener = (event) => {
      try {
        const r = handler(event) as unknown;
        if (r && typeof (r as { then?: unknown }).then === "function") {
          (r as Promise<unknown>).then(undefined, (err) => onError(err));
        }
      } catch (err) {
        onError(err);
      }
    };
    el.addEventListener(ev.type, wrapped, ev.capture);
    state.listeners!.set(key, wrapped);
  } else {
    state.listeners!.delete(key);
  }
}

export function removeListener(el: Element, state: HostState, prop: string): void {
  const ev = parseEvent(prop);
  const key = prop; // key by React prop name so distinct props never collide
  const existing = state.listeners!.get(key);
  if (existing) {
    el.removeEventListener(ev.type, existing, ev.capture);
    state.listeners!.delete(key);
  }
}

export function normalizeAttr(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

export function setAttribute(el: Element, name: string, value: unknown): void {
  const attr = normalizeAttr(name);
  // Skip unsafe names: the DOM throws on them, and they must not reach markup.
  if (!isValidAttrName(attr)) return;
  if (value == null || value === false) {
    el.removeAttribute(attr);
    return;
  }
  if (value === true) {
    el.setAttribute(attr, "");
    return;
  }
  if (attr === "style" && typeof value === "object") {
    el.setAttribute("style", serializeStyleObject(value as Record<string, unknown>));
    return;
  }
  // Reflect form values onto the property too so inputs stay controlled.
  if (attr === "value" && "value" in el) {
    (el as unknown as { value: unknown }).value = value;
  }
  el.setAttribute(attr, String(value));
}

export function serializeStyleObject(style: Record<string, unknown>): string {
  let css = "";
  for (const [prop, value] of Object.entries(style)) {
    if (value == null || value === false) continue;
    const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    css += `${kebab}:${value};`;
  }
  return css;
}
