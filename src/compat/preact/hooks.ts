/**
 * `denext/preact/hooks` — Preact's hooks (`preact/hooks`) on denext: the React-shaped hooks
 * (`useState`, `useEffect`, `useRef`, …) plus Preact's own `useErrorBoundary`.
 *
 * @module
 */

import {
  useCallback,
  useDebugValue as coreUseDebugValue,
  useLayoutEffect,
  useRef,
} from "../react.ts";
import { currentFiber } from "../../client/fiber/hooks-dispatcher.ts";
import { type Fiber, HookBoundaryBit, setBit } from "../../client/fiber/fiber.ts";
import { componentErrorInfo } from "../../client/fiber/fiber-utils.ts";
import { resetBoundary } from "../../client/fiber/boundaries.ts";
import { options } from "./options.ts";

export {
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "../react.ts";

/** What Preact passes a `useErrorBoundary` callback with the error. */
export interface ErrorInfo {
  /** The component the boundary is, as a one-frame stack. */
  componentStack?: string;
}

/**
 * Show a value in the DevTools (Preact's `useDebugValue`), also passing it to Preact's
 * `options.useDebugValue` hook when one is set.
 *
 * @param value The value.
 * @param formatter Formats it for display.
 */
export function useDebugValue<T>(value: T, formatter?: (value: T) => unknown): void {
  if (options.useDebugValue) {
    options.useDebugValue((formatter ? formatter(value) : value) as string | number);
  }
  coreUseDebugValue(value, formatter);
}

/**
 * Preact's `useErrorBoundary`: make this component an error boundary for what it renders. An
 * error a descendant throws while rendering (or from an effect or event handler) re-renders this
 * component with `[error, reset]`; `callback` is called with the error once that render
 * commits, and `reset()` clears it and renders the children again. While it holds an error the
 * component is not a boundary, so an error its error UI throws goes to the boundary above.
 *
 * A server render never catches here (`[undefined, reset]`): the error goes to the server's
 * own boundary handling. A production build compiles the reconciler's support for this in only
 * when the app's own sources name `useErrorBoundary` or import preact-iso.
 *
 * @param callback Called with each caught error and its {@link ErrorInfo}.
 * @returns The caught error (or `undefined`) and a function that clears it.
 */
export function useErrorBoundary(
  callback?: (error: unknown, info: ErrorInfo) => Promise<void> | void,
): [unknown, () => void] {
  const fiber = currentFiber;
  const error = fiber?.ext?.__error ?? undefined;
  // A boundary only while it shows its children: a caught error must not loop back here.
  if (fiber) setBit(fiber, HookBoundaryBit, error === undefined);
  const self = useRef<Fiber | null>(fiber);
  self.current = fiber;
  const report = useRef(callback);
  report.current = callback;
  const reported = useRef<unknown>(undefined);
  useLayoutEffect(() => {
    if (error === reported.current) return;
    reported.current = error;
    if (error !== undefined && self.current) {
      report.current?.(error, componentErrorInfo(self.current));
    }
  });
  const reset = useCallback(() => {
    if (self.current) resetBoundary(self.current);
  }, []);
  return [error, reset];
}
