/**
 * `denext/preact/hooks` — Preact's hooks (`preact/hooks`) on denext: the React-shaped hooks
 * (`useState`, `useEffect`, `useRef`, …) plus Preact's own `useErrorBoundary`.
 *
 * @module
 */

export {
  useCallback,
  useContext,
  useDebugValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "../react.ts";

/**
 * Preact's `useErrorBoundary`: `[error, reset]` for an error thrown below this component.
 * denext catches render errors with an error boundary (`ErrorBoundary` from `denext`, or a
 * route's `error.tsx`) instead, so this never sees one: it returns `[undefined, reset]`, and
 * `denext migrate --from fresh` lists the components that call it.
 *
 * @param _callback Called with a caught error (never, on denext).
 * @returns `[undefined, reset]`.
 */
export function useErrorBoundary(
  _callback?: (error: unknown, info: unknown) => void,
): [unknown, () => void] {
  return [undefined, () => {}];
}
