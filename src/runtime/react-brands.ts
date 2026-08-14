/**
 * Well-known React "type-of" brand symbols, used to make denext's `forwardRef`,
 * `memo`, portals, etc. classifiable by a `react-is`-compatible layer.
 *
 * They are created with `Symbol.for(...)`, so they are the *same* symbols React
 * itself uses (React registers its brands in the global symbol registry too).
 * denext's `forwardRef`/`memo` return React's non-callable element **objects**
 * (`{ $$typeof, render }` / `{ $$typeof, type, compare }`); the renderers resolve
 * them through {@link resolveComponentType}. Other markers (Radix's `Slot`, `lazy`,
 * portals, context) are still branded in place via {@link brand}. Either way the
 * `$$typeof` brand is what `react-is` classifiers — and libraries like Radix that
 * read `$$typeof` — recognize.
 *
 * @module
 */

/** `$$typeof` of a React element (React ≥19 transitional brand). */
export const REACT_ELEMENT_TYPE: symbol = Symbol.for("react.transitional.element");
/** `$$typeof` of a React element (React ≤18 / legacy brand; still accepted). */
export const REACT_LEGACY_ELEMENT_TYPE: symbol = Symbol.for("react.element");
/** Brand for a `forwardRef` component. */
export const REACT_FORWARD_REF_TYPE: symbol = Symbol.for("react.forward_ref");
/** Brand for a `memo` component. */
export const REACT_MEMO_TYPE: symbol = Symbol.for("react.memo");
/** Brand for a `lazy` component. */
export const REACT_LAZY_TYPE: symbol = Symbol.for("react.lazy");
/** Brand for a portal element. */
export const REACT_PORTAL_TYPE: symbol = Symbol.for("react.portal");
/** Type marker for a `Fragment`. */
export const REACT_FRAGMENT_TYPE: symbol = Symbol.for("react.fragment");
/** Type marker for `Suspense`. */
export const REACT_SUSPENSE_TYPE: symbol = Symbol.for("react.suspense");
/** Type marker for `StrictMode`. */
export const REACT_STRICT_MODE_TYPE: symbol = Symbol.for("react.strict_mode");
/** Non-enumerable property name carrying a type brand. */
export const TYPEOF_KEY = "$$typeof";

/**
 * Stamp `value` with an **enumerable** `$$typeof` brand (and any extra fields),
 * returning it. React's `forwardRef`/`memo`/`lazy` results expose `$$typeof` and
 * their metadata (`render`/`type`/`compare`) as enumerable own properties, and
 * some libraries read them by enumeration (`Object.keys`, spreads) rather than by
 * direct access — so denext matches that shape. This is only ever applied to
 * *component functions* (never elements/props), so the enumerable brand can't leak
 * into DOM prop spreads or shallow prop-equality comparisons (those compare an
 * element's props / a component's identity, not the component's own keys).
 *
 * @param value The function/object to brand.
 * @param brand The `$$typeof` brand symbol.
 * @param extra Additional fields (e.g. `render`, `type`, `compare`).
 * @returns `value`, branded.
 */
export function brand<T>(value: T, brand: symbol, extra?: Record<string, unknown>): T {
  try {
    Object.defineProperty(value, TYPEOF_KEY, {
      value: brand,
      enumerable: true,
      configurable: true,
    });
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        Object.defineProperty(value, k, { value: v, enumerable: true, configurable: true });
      }
    }
  } catch {
    // Frozen/exotic values can't be branded; classification just falls back.
  }
  return value;
}

/** Read the `$$typeof` brand of a value, if any. */
export function brandOf(value: unknown): symbol | undefined {
  if (value == null) return undefined;
  const t = typeof value;
  if (t !== "object" && t !== "function") return undefined;
  const brand = (value as Record<string, unknown>)[TYPEOF_KEY];
  return typeof brand === "symbol" ? brand : undefined;
}

/** A resolved component "type": the render function and how it must be invoked. */
export interface ResolvedComponentType {
  /** The function to call — a plain/forwardRef render fn, or a class constructor. */
  fn: unknown;
  /** True when `fn` takes React's `(props, ref)` forwardRef signature. */
  forwardsRef: boolean;
}

/**
 * Resolve a component "type" through denext's `memo` / `forwardRef` object wrappers
 * (`{ $$typeof: REACT_MEMO_TYPE, type }` / `{ $$typeof: REACT_FORWARD_REF_TYPE,
 * render }`) to the underlying function, following nesting like
 * `memo(forwardRef(fn))`. A plain function/class resolves to itself. The common case
 * — `type` is already a function — is a single `typeof` check with no allocation, so
 * this stays cheap on the render hot path.
 *
 * @param type A JSX element type (function, class, host string, or wrapper object).
 * @returns The function to invoke and whether it expects `(props, ref)`.
 */
export function resolveComponentType(type: unknown): ResolvedComponentType {
  // Fast path: a plain function/class component (the overwhelming majority).
  if (typeof type === "function") return { fn: type, forwardsRef: false };
  let t: unknown = type;
  for (;;) {
    const b = brandOf(t);
    if (b === REACT_MEMO_TYPE) {
      t = (t as { type?: unknown }).type;
      if (typeof t === "function") return { fn: t, forwardsRef: false };
      // else keep unwrapping (nested memo / memo(forwardRef(...))).
    } else if (b === REACT_FORWARD_REF_TYPE) {
      return { fn: (t as { render?: unknown }).render, forwardsRef: true };
    } else {
      return { fn: t, forwardsRef: false };
    }
  }
}

/**
 * Whether `type` is a renderable component: a function/class, or a `memo`/`forwardRef`
 * object wrapper. Host strings and everything else are not. Used by the renderers to
 * decide the component branch (a non-callable wrapper must not fall through to the
 * host-element path).
 */
export function isComponentType(type: unknown): boolean {
  if (typeof type === "function") return true;
  const b = brandOf(type);
  return b === REACT_MEMO_TYPE || b === REACT_FORWARD_REF_TYPE;
}

/**
 * Invoke a resolved **non-class** component: a forwardRef render fn receives
 * `(props, ref)` (denext threads `ref` via `props.ref`); a plain component receives
 * `(props)`. A wrapper hiding a class (`memo(Class)`) can't go through the object
 * path — the class runtime needs the raw constructor — so this throws a guided error
 * rather than the opaque native "Class constructor cannot be invoked without 'new'".
 *
 * @param resolved The output of {@link resolveComponentType}.
 * @param props The element's props.
 * @returns The component's rendered result (possibly a promise for a server component).
 */
export function invokeComponent(resolved: ResolvedComponentType, props: unknown): unknown {
  const fn = resolved.fn as
    | ((p: unknown, ref?: unknown) => unknown)
    | { prototype?: { isReactComponent?: unknown } };
  if (typeof fn !== "function") {
    throw new Error(
      "denext: element type is not a valid component (memo/forwardRef wrapping a non-component?).",
    );
  }
  if ((fn as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent != null) {
    throw new Error(
      "denext: memo() of a class component is unsupported; wrap the class in a " +
        "function component (or memo the function) instead.",
    );
  }
  return resolved.forwardsRef
    ? (fn as (p: unknown, ref?: unknown) => unknown)(
      props,
      (props as { ref?: unknown })?.ref ?? null,
    )
    : (fn as (p: unknown) => unknown)(props);
}

/**
 * A human-readable name for a component type — used in DevTools nodes and error/
 * component stacks. Unwraps `memo`/`forwardRef` object wrappers to name the inner
 * component (e.g. `Memo(List)`, `ForwardRef(Input)`), falling back to `"Component"`
 * for non-components.
 */
export function componentDisplayName(type: unknown): string {
  const b = brandOf(type);
  if (b === REACT_MEMO_TYPE) {
    return `Memo(${componentDisplayName((type as { type?: unknown }).type)})`;
  }
  if (b === REACT_FORWARD_REF_TYPE) {
    const r = (type as { render?: { displayName?: string; name?: string } }).render;
    return `ForwardRef(${r?.displayName || r?.name || "Anonymous"})`;
  }
  if (typeof type === "function") {
    const f = type as { displayName?: string; name?: string };
    return f.displayName || f.name || "Anonymous";
  }
  return "Component";
}
