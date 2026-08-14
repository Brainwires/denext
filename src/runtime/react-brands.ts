/**
 * Well-known React "type-of" brand symbols, used to make denext's `forwardRef`,
 * `memo`, portals, etc. classifiable by a `react-is`-compatible layer.
 *
 * They are created with `Symbol.for(...)`, so they are the *same* symbols React
 * itself uses (React registers its brands in the global symbol registry too).
 * A denext `forwardRef`/`memo` result carries a non-enumerable `$$typeof` set to
 * one of these, so `react-is` classifiers — and libraries like Radix that read
 * `$$typeof` — recognize it.
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
