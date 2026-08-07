// Error boundaries — the mechanism behind App Router `error.tsx`.
//
// An <ErrorBoundary fallback={ErrorComponent}> renders `fallback` (given the
// caught error and a `reset` function) when a descendant throws during render.
// Thrown *thenables* are NOT caught here — those are suspensions handled by the
// nearest <Suspense>.

import type { Component, VNode, VNodeChildren } from "../jsx/types.ts";

/** Fragment marker re-exported so `VNodeType` stays fully documentable. */
export { FRAGMENT } from "../jsx/types.ts";

/** Re-exported so the public error-boundary API surface stays documentable. */
export type {
  Component,
  Key,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "../jsx/types.ts";

/** Marker used as the `type` of an ErrorBoundary VNode so the renderer recognizes it. */
export const ERROR_BOUNDARY: symbol = Symbol.for("denext.errorBoundary");

/** Props passed to the fallback component rendered when a child throws. */
export interface ErrorFallbackProps {
  /** The error that was caught during rendering. */
  error: Error;
  /** Clears the caught error and re-attempts rendering the children. */
  reset: () => void;
}

/** Props for the {@link ErrorBoundary} component. */
export interface ErrorBoundaryProps {
  /** Component rendered with the caught error and a `reset` function. */
  fallback: Component<ErrorFallbackProps>;
  /** Content whose render-time errors this boundary catches. */
  children?: VNodeChildren;
}

/** An error boundary. Renders `fallback` when a child throws during render. */
export function ErrorBoundary(props: ErrorBoundaryProps): VNode {
  return {
    type: ERROR_BOUNDARY as unknown as string,
    props: props as unknown as Record<string, unknown>,
    key: null,
  };
}

// ---- notFound() ------------------------------------------------------------

/** Brand symbol tagging {@link NotFoundError} instances so they survive serialization boundaries. */
export const NOT_FOUND: symbol = Symbol.for("denext.notFound");

/** Error thrown by {@link notFound} to trigger the nearest not-found UI (HTTP 404). */
export class NotFoundError extends Error {
  /** Brand flag identifying this as a not-found signal. */
  readonly [NOT_FOUND] = true;
  /** Create a not-found error with the standard `NEXT_NOT_FOUND` message. */
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/** Throw to render the nearest not-found UI with a 404 status. */
export function notFound(): never {
  throw new NotFoundError();
}

/** True if `value` is a {@link NotFoundError} raised by `notFound()`. */
export function isNotFound(value: unknown): value is NotFoundError {
  return (
    typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[NOT_FOUND] === true
  );
}

/** Normalize a caught error into an Error instance for a fallback component. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : String(value));
}
