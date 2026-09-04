// Shared DOM prop/attribute/event/ref application, used by both the recursive
// reconciler and the fiber reconciler. Every function takes the target element
// explicitly plus a small mutable {@link HostState} bag (listeners + the attached
// ref and its cleanup), so it works against either reconciler's node type. Event
// and form-action handlers route thrown/rejected errors through an injected
// `onError` callback, keeping error-boundary routing renderer-specific.

import { isValidAttrName, sanitizeUrlAttr, warnDangerousHtml } from "../jsx/render-to-string.ts";
import { beginFormAction, endFormAction, type FormStatusSignal } from "../runtime/form-status.ts";
import { beginEventDispatch, endEventDispatch } from "./event-priority.ts";

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
    if (name.startsWith("__dnx")) continue; // framework-internal marker, never a DOM attr
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
    } else if (name === "dangerouslySetInnerHTML") {
      // The prop is gone: drop the raw HTML so reconciled children can take over.
      el.innerHTML = "";
    } else if (name === "style" && oldProps.style !== null && typeof oldProps.style === "object") {
      // Remove only the style properties denext set — never the whole attribute, so
      // inline properties written outside the render (e.g. floating-ui's CSS vars) live.
      patchStyle(el, oldProps.style as Record<string, unknown>, undefined);
    } else {
      const attr = domAttrName(el, name);
      if (isValidAttrName(attr)) el.removeAttribute(attr);
    }
  }

  // Refs: attach/detach with React-19 semantics (support cleanup-returning
  // callback refs; detach the old ref when it changes). Handled outside the loop
  // so we can compare the previous and next ref.
  updateRef(state, oldProps.ref, newProps.ref, el);

  for (const [name, value] of Object.entries(newProps)) {
    if (name === "children" || name === "key" || name === "ref") continue;
    if (name.startsWith("__dnx")) continue; // framework-internal marker, never a DOM attr
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
    // Raw HTML injection (React parity). Apply innerHTML instead of letting the
    // object fall through to setAttribute; warn (dev) about the XSS sink.
    if (name === "dangerouslySetInnerHTML") {
      if (oldProps[name] !== value) {
        const html = (value as { __html?: unknown } | null | undefined)?.__html;
        if (typeof html === "string") {
          warnDangerousHtml(el.tagName.toLowerCase());
          el.innerHTML = html;
        }
      }
      continue;
    }
    if (typeof value === "function") continue; // non-event function props aren't attrs
    if (oldProps[name] === value) continue;
    // Style objects are patched per-property (diffed against the old object) so foreign
    // inline properties — floating-ui's `--available-*`/`--anchor-*` vars, any imperative
    // `element.style` write — survive re-renders. A whole-attribute rewrite would wipe
    // them and drive a reposition loop. String styles fall through to setAttribute.
    if (name === "style" && typeof value === "object") {
      const prev = typeof oldProps.style === "object"
        ? oldProps.style as Record<string, unknown>
        : undefined;
      patchStyle(el, prev, value as Record<string, unknown>);
      continue;
    }
    setAttribute(el, name, value);
  }
}

/** Wire a function-valued form `action` to the form's submit event. */
function setFormAction(
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
function updateRef(state: HostState, oldRef: unknown, newRef: unknown, el: Element): void {
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
const REACT_EVENT_MAP: Record<string, string> = {
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
function parseEvent(prop: string): ParsedEvent {
  let name = prop.slice(2); // strip "on"
  let capture = false;
  if (name.endsWith("Capture")) {
    capture = true;
    name = name.slice(0, -"Capture".length);
  }
  const lower = name.toLowerCase();
  return { type: REACT_EVENT_MAP[lower] ?? lower, capture };
}

function setListener(
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
      // A state update enqueued synchronously in a DOM event handler is urgent and
      // must keep its priority even while an async transition is pending — see
      // event-priority.ts + the reconciler's scheduleUpdate. (No-op unless an async
      // transition is in flight.)
      beginEventDispatch();
      try {
        // React-compat: libraries (Base UI / floating-ui-react, etc.) reach the DOM
        // event via `event.nativeEvent` (and gate on `"nativeEvent" in event`). denext
        // passes the native event directly, so point `.nativeEvent` at itself — React's
        // `SyntheticEvent.nativeEvent` IS the DOM event, and denext's event already is
        // that DOM event, so the self-reference is faithful. Without it `event.nativeEvent`
        // is `undefined` and code like `"composedPath" in event.nativeEvent` throws.
        if (event != null && typeof event === "object" && !("nativeEvent" in event)) {
          try {
            (event as { nativeEvent?: Event }).nativeEvent = event;
          } catch { /* non-extensible event (rare) — leave as-is */ }
        }
        const r = handler(event) as unknown;
        if (r && typeof (r as { then?: unknown }).then === "function") {
          (r as Promise<unknown>).then(undefined, (err) => onError(err));
        }
      } catch (err) {
        onError(err);
      } finally {
        endEventDispatch();
      }
    };
    el.addEventListener(ev.type, wrapped, ev.capture);
    state.listeners!.set(key, wrapped);
  } else {
    state.listeners!.delete(key);
  }
}

function removeListener(el: Element, state: HostState, prop: string): void {
  const ev = parseEvent(prop);
  const key = prop; // key by React prop name so distinct props never collide
  const existing = state.listeners!.get(key);
  if (existing) {
    el.removeEventListener(ev.type, existing, ev.capture);
    state.listeners!.delete(key);
  }
}

function normalizeAttr(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

const SVG_NS = "http://www.w3.org/2000/svg";
// SVG attributes that are genuinely camelCase in the DOM and must NOT be kebab-cased.
// Everything else camelCase on an SVG element is a React-style presentation attribute
// (strokeWidth → stroke-width, strokeLinecap → stroke-linecap, …) that SVG spells with
// hyphens; without the conversion the attribute is ignored and the graphic renders with
// the wrong (default) stroke/fill/etc — e.g. lucide icons come out hairline-thin.
const SVG_KEEP_CAMELCASE = new Set([
  "viewBox",
  "preserveAspectRatio",
  "attributeName",
  "attributeType",
  "baseFrequency",
  "baseProfile",
  "calcMode",
  "clipPathUnits",
  "diffuseConstant",
  "edgeMode",
  "filterUnits",
  "gradientTransform",
  "gradientUnits",
  "kernelMatrix",
  "kernelUnitLength",
  "keyPoints",
  "keySplines",
  "keyTimes",
  "lengthAdjust",
  "limitingConeAngle",
  "markerHeight",
  "markerUnits",
  "markerWidth",
  "maskContentUnits",
  "maskUnits",
  "numOctaves",
  "pathLength",
  "patternContentUnits",
  "patternTransform",
  "patternUnits",
  "pointsAtX",
  "pointsAtY",
  "pointsAtZ",
  "primitiveUnits",
  "refX",
  "refY",
  "repeatCount",
  "repeatDur",
  "requiredExtensions",
  "specularConstant",
  "specularExponent",
  "spreadMethod",
  "startOffset",
  "stdDeviation",
  "stitchTiles",
  "surfaceScale",
  "systemLanguage",
  "tableValues",
  "targetX",
  "targetY",
  "textLength",
  "viewTarget",
  "xChannelSelector",
  "yChannelSelector",
  "zoomAndPan",
]);

/**
 * Map a React prop name to the actual DOM attribute name for `el`. Handles
 * `className`/`htmlFor`, and — on SVG/MathML elements — converts React's camelCase
 * presentation attributes to the hyphenated names SVG expects (keeping the structural
 * camelCase attributes like `viewBox` as-is).
 */
function domAttrName(el: Element, name: string): string {
  const base = normalizeAttr(name);
  if (
    el.namespaceURI === SVG_NS && /[a-z][A-Z]/.test(base) &&
    !SVG_KEEP_CAMELCASE.has(base) && !base.startsWith("data") && !base.startsWith("aria")
  ) {
    return base.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  }
  return base;
}

function setAttribute(el: Element, name: string, value: unknown): void {
  const attr = domAttrName(el, name);
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
    // Patch per-property (preserving foreign inline props) rather than rewriting the
    // whole attribute. applyProps handles the diff against the old style; a direct
    // caller lands here with no previous object, so this only adds/updates keys.
    patchStyle(el, undefined, value as Record<string, unknown>);
    return;
  }
  // Reflect form values onto the property too so inputs stay controlled.
  if (attr === "value" && "value" in el) {
    (el as unknown as { value: unknown }).value = value;
  }
  // Drop a dangerous URL scheme (javascript:/vbscript:/executable data:) before
  // it reaches a URL-bearing attribute — the same guard the SSR serializer applies.
  const str = String(value);
  const safe = sanitizeUrlAttr(el.tagName.toLowerCase(), attr, str);
  if (safe === null) {
    el.removeAttribute(attr);
    return;
  }
  el.setAttribute(attr, safe);
}

function serializeStyleObject(style: Record<string, unknown>): string {
  let css = "";
  for (const [prop, value] of Object.entries(style)) {
    if (value == null || value === false) continue;
    css += `${styleProp(prop)}:${value};`;
  }
  return css;
}

/**
 * A style object key as its CSS property name: custom properties (`--foo`) pass
 * through untouched; camelCase is hyphenated (`maxHeight` → `max-height`,
 * `WebkitTransform` → `-webkit-transform`).
 */
function styleProp(prop: string): string {
  if (prop.startsWith("--")) return prop;
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * Apply a React `style` object to an element's inline style **per property**, diffing
 * against the previous style object, instead of rewriting the whole `style` attribute.
 *
 * This mirrors react-dom (which patches individual style properties and never touches
 * `style` wholesale) and is load-bearing for interop: libraries such as floating-ui set
 * CSS custom properties directly on the element (`element.style.setProperty('--available-height', …)`)
 * OUTSIDE of the render, and rely on React never clobbering them. A wholesale
 * `setAttribute("style", …)` on every commit erased those vars, which changed the
 * element's size (`max-height: var(--available-height)`), which fired floating-ui's
 * ResizeObserver, which repositioned and re-rendered — an infinite reposition loop that
 * made a popup flicker. Touching only the keys denext manages leaves foreign inline
 * properties intact, so positioning settles.
 */
export function patchStyle(
  el: Element,
  oldStyle: Record<string, unknown> | undefined,
  newStyle: Record<string, unknown> | undefined,
): void {
  const style = (el as unknown as { style?: CSSStyleDeclaration }).style;
  // No live CSSStyleDeclaration (e.g. a minimal test shim): fall back to the whole
  // attribute — the per-property preservation only matters against a real DOM anyway.
  if (!style || typeof style.setProperty !== "function") {
    if (newStyle) el.setAttribute("style", serializeStyleObject(newStyle));
    else el.removeAttribute("style");
    return;
  }
  // Remove properties that were set before but are gone now.
  if (oldStyle) {
    for (const prop of Object.keys(oldStyle)) {
      if (newStyle && prop in newStyle) continue;
      style.removeProperty(styleProp(prop));
    }
  }
  // Set changed/added properties (skip unchanged ones so we don't restart transitions).
  if (newStyle) {
    for (const [prop, value] of Object.entries(newStyle)) {
      if (oldStyle && oldStyle[prop] === value) continue;
      const name = styleProp(prop);
      if (value == null || value === false || value === "") style.removeProperty(name);
      else style.setProperty(name, String(value));
    }
  }
}
