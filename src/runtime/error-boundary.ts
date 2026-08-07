// Error boundaries — the mechanism behind App Router `error.tsx`.
//
// An <ErrorBoundary fallback={ErrorComponent}> renders `fallback` (given the
// caught error and a `reset` function) when a descendant throws during render.
// Thrown *thenables* are NOT caught here — those are suspensions handled by the
// nearest <Suspense>.

import type { Component, VNode, VNodeChildren } from "../jsx/types.ts";

export const ERROR_BOUNDARY = Symbol.for("denext.errorBoundary");

export interface ErrorFallbackProps {
  error: Error;
  reset: () => void;
}

export interface ErrorBoundaryProps {
  fallback: Component<ErrorFallbackProps>;
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

export const NOT_FOUND = Symbol.for("denext.notFound");

export class NotFoundError extends Error {
  readonly [NOT_FOUND] = true;
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/** Throw to render the nearest not-found UI with a 404 status. */
export function notFound(): never {
  throw new NotFoundError();
}

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
