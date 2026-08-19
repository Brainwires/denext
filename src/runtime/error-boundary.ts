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
  /**
   * The error that was caught during rendering. In production a server render
   * error is redacted (generic message) and carries an opaque `digest` that
   * correlates with the server log; in development the real error is passed.
   */
  error: Error & { digest?: string };
  /** Clears the caught error and re-attempts rendering the children. */
  reset: () => void;
}

/** Props for the {@link ErrorBoundary} component. */
export interface ErrorBoundaryProps {
  /** Component rendered with the caught error and a `reset` function. */
  fallback: Component<ErrorFallbackProps>;
  /** Content whose render-time errors this boundary catches. */
  children?: VNodeChildren;
  /**
   * Internal instrumentation hook: invoked with the **raw** caught error (before
   * redaction) when this boundary catches — used by the server to report it to
   * `onRequestError` and log it, since a caught boundary otherwise swallows the
   * error silently. Not part of the public `error.tsx` contract.
   */
  onCaught?: (error: unknown) => void;
}

/**
 * Safely invoke an {@link ErrorBoundaryProps.onCaught} reporter (if present) with
 * the raw caught error. A throwing reporter must never break rendering, so it is
 * swallowed. Shared by every renderer's boundary handler.
 *
 * @param props The boundary VNode's props.
 * @param error The raw caught error.
 */
export function reportBoundaryError(props: Record<string, unknown>, error: unknown): void {
  const cb = props.onCaught as ((error: unknown) => void) | undefined;
  if (typeof cb === "function") {
    try {
      cb(error);
    } catch { /* a reporter must never break rendering */ }
  }
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

// ---- forbidden() / unauthorized() ------------------------------------------

/** Brand symbol tagging {@link ForbiddenError} instances. */
export const FORBIDDEN: symbol = Symbol.for("denext.forbidden");
/** Brand symbol tagging {@link UnauthorizedError} instances. */
export const UNAUTHORIZED: symbol = Symbol.for("denext.unauthorized");

/** Error thrown by {@link forbidden} to render the nearest `forbidden` UI (HTTP 403). */
export class ForbiddenError extends Error {
  /** Brand flag identifying this as a forbidden signal. */
  readonly [FORBIDDEN] = true;
  /** Create a forbidden error. */
  constructor() {
    super("NEXT_FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

/** Error thrown by {@link unauthorized} to render the nearest `unauthorized` UI (HTTP 401). */
export class UnauthorizedError extends Error {
  /** Brand flag identifying this as an unauthorized signal. */
  readonly [UNAUTHORIZED] = true;
  /** Create an unauthorized error. */
  constructor() {
    super("NEXT_UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

/** Throw to render the nearest `forbidden.tsx` UI with a 403 status. */
export function forbidden(): never {
  throw new ForbiddenError();
}

/** Throw to render the nearest `unauthorized.tsx` UI with a 401 status. */
export function unauthorized(): never {
  throw new UnauthorizedError();
}

/** True if `value` is a {@link ForbiddenError} raised by `forbidden()`. */
export function isForbidden(value: unknown): value is ForbiddenError {
  return (
    typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[FORBIDDEN] === true
  );
}

/** True if `value` is an {@link UnauthorizedError} raised by `unauthorized()`. */
export function isUnauthorized(value: unknown): value is UnauthorizedError {
  return (
    typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[UNAUTHORIZED] === true
  );
}

// ---- redirect() / permanentRedirect() --------------------------------------

/** Brand symbol tagging {@link RedirectError} instances. */
export const REDIRECT: symbol = Symbol.for("denext.redirect");

/** Error thrown by {@link redirect}/{@link permanentRedirect} to issue an HTTP redirect. */
export class RedirectError extends Error {
  /** Brand flag identifying this as a redirect signal. */
  readonly [REDIRECT] = true;
  /** Destination URL for the redirect. */
  readonly url: string;
  /** HTTP status code (307 temporary, 308 permanent). */
  readonly status: number;
  /** Create a redirect signal to `url` with the given `status`. */
  constructor(url: string, status: number) {
    super(`NEXT_REDIRECT:${status}:${url}`);
    this.name = "RedirectError";
    this.url = url;
    this.status = status;
  }
}

/** Throw to issue a temporary (307) redirect to `url`, from a component or action. */
export function redirect(url: string, status = 307): never {
  throw new RedirectError(url, status);
}

/** Throw to issue a permanent (308) redirect to `url`. */
export function permanentRedirect(url: string): never {
  throw new RedirectError(url, 308);
}

/** True if `value` is a {@link RedirectError} raised by `redirect()`. */
export function isRedirect(value: unknown): value is RedirectError {
  return (
    typeof value === "object" && value !== null &&
    (value as Record<symbol, unknown>)[REDIRECT] === true
  );
}

/**
 * True for any denext control-flow signal (`notFound`/`forbidden`/`unauthorized`/
 * `redirect`) that error boundaries must re-throw rather than catch.
 */
export function isControlSignal(value: unknown): boolean {
  return isNotFound(value) || isForbidden(value) || isUnauthorized(value) ||
    isRedirect(value);
}

/** Normalize a caught error into an Error instance for a fallback component. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : String(value));
}

/**
 * A short, deterministic, non-cryptographic digest of an error — safe to show
 * clients and to correlate with the server log. FNV-1a, doubled to 16 hex chars;
 * it is an opaque grouping id (not a secret/MAC), so a fast synchronous hash is
 * the right tool here.
 *
 * @param error The caught value.
 * @returns A 16-character hex digest.
 */
export function errorDigest(error: unknown): string {
  const text = error instanceof Error
    ? `${error.name}:${error.message}:${error.stack ?? ""}`
    : String(error);
  let a = 0x811c9dc5;
  let b = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ (c + 0x77), 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/**
 * Normalize a caught render error into the Error handed to an `error.tsx` /
 * `global-error.tsx` component. In **production** the error is REDACTED — a generic
 * message plus an opaque `digest` — so `{error.message}`/`{error.stack}` cannot leak
 * internal detail (DB DSNs, stacks, server paths) to clients; the real error is
 * logged server-side, correlatable by digest. In **development** the real error is
 * passed through. Gated by `globalThis.__denextDev` (set by the dev server).
 *
 * @param error The caught value.
 * @returns The Error to hand the fallback component (carries `digest` in prod).
 */
export function toClientError(error: unknown): Error & { digest?: string } {
  const isDev = (globalThis as { __denextDev?: boolean }).__denextDev === true;
  if (isDev) return error instanceof Error ? error : new Error(String(error));
  const digest = errorDigest(error);
  console.error(`denext: server error [digest ${digest}]`, error);
  return Object.assign(new Error("Internal Server Error"), { digest });
}
