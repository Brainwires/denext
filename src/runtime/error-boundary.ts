// Error boundaries — the mechanism behind App Router `error.tsx`.
//
// An <ErrorBoundary fallback={ErrorComponent}> renders `fallback` (given the
// caught error and a `reset` function) when a descendant throws during render.
// Thrown *thenables* are NOT caught here — those are suspensions handled by the
// nearest <Suspense>.

import { isPostpone } from "./postpone.ts";
import { isThenable } from "./suspense.ts";
import type { Component, VNode, VNodeChildren } from "../jsx/types.ts";
// Type-only (erased at build): lets `redirect`/`permanentRedirect` autocomplete this app's routes
// when `.denext/routes.ts` is imported, while still accepting any string (external URLs).
import type { Href } from "../client/navigation.ts";

/** Re-exported so the public error-boundary API surface stays documentable. */
export type { Component, VNode, VNodeChildren } from "../jsx/types.ts";

/** Marker used as the `type` of an ErrorBoundary VNode so the renderer recognizes it. */
export const ERROR_BOUNDARY: symbol = /* @__PURE__ */ Symbol.for("denext.errorBoundary");

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
  /**
   * Makes this a *signal* boundary: it catches exactly the throws for which `catches`
   * returns true (a control signal such as `notFound()`) and lets everything else —
   * suspensions, other signals, real errors — propagate to the boundaries above. The
   * caught value reaches `fallback` unredacted. This is how the per-segment
   * `not-found.tsx` / `forbidden.tsx` / `unauthorized.tsx` boundaries are built.
   */
  catches?: (error: unknown) => boolean;
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

/**
 * Whether an error caught at an error boundary must propagate instead: a suspension (the
 * enclosing Suspense retries), a control signal (redirect/notFound bubble to the page handler),
 * or a renderer-specific pass-through such as PPR's Postpone.
 */
function passesThroughBoundary(
  err: unknown,
  alsoPasses?: (err: unknown) => boolean,
): boolean {
  return isThenable(err) || isControlSignal(err) || (alsoPasses?.(err) ?? false);
}

/**
 * Whether the boundary described by `props` must let `err` propagate. A signal boundary
 * (`catches` set — `not-found.tsx` and friends) decides by its predicate alone, so it
 * catches its control signal and passes suspensions, other signals and real errors up;
 * an ordinary error boundary follows {@link passesThroughBoundary}.
 */
export function boundaryLetsThrough(
  props: Record<string, unknown>,
  err: unknown,
  alsoPasses?: (err: unknown) => boolean,
): boolean {
  const catches = props.catches as ((err: unknown) => boolean) | undefined;
  return catches ? !catches(err) : passesThroughBoundary(err, alsoPasses);
}

/** The Error a boundary's fallback receives: raw for a signal boundary, redacted (prod) otherwise. */
export function boundaryFallbackError(props: Record<string, unknown>, err: unknown): Error {
  return props.catches ? toError(err) : toClientError(err);
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
const NOT_FOUND: symbol = /* @__PURE__ */ Symbol.for("denext.notFound");

/** Error thrown by {@link notFound} to trigger the nearest not-found UI (HTTP 404). */
export class NotFoundError extends Error {
  /** Brand flag identifying this as a not-found signal. */
  declare readonly [NOT_FOUND]: true;
  /** Next.js's `digest` for the signal, which libraries test for (see {@link nextDigestOf}). */
  readonly digest: string = `${HTTP_FALLBACK_DIGEST};404`;
  /** Create a not-found error with the standard `NEXT_NOT_FOUND` message. */
  constructor() {
    super("NEXT_NOT_FOUND");
    // Set here, not as a field: a computed field key pins the class into every bundle.
    (this as Record<symbol, unknown>)[NOT_FOUND] = true;
    this.name = "NotFoundError";
  }
}

/** Throw to render the nearest not-found UI with a 404 status. */
export function notFound(): never {
  throw new NotFoundError();
}

/**
 * The `digest` prefix of Next.js's HTTP access errors (`notFound()` / `forbidden()` /
 * `unauthorized()` throw `NEXT_HTTP_ERROR_FALLBACK;<status>`).
 */
const HTTP_FALLBACK_DIGEST = "NEXT_HTTP_ERROR_FALLBACK";

/**
 * The `digest` string of `value` (an Error thrown in Next.js's control-flow format), or
 * `undefined`. A library written for Next (`@clerk/nextjs`'s `auth.protect()`, for one) throws
 * Next's errors itself and recognizes Next's by this digest, so denext's signals carry the same
 * digest and denext recognizes theirs.
 */
function nextDigestOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const digest = (value as { digest?: unknown }).digest;
  return typeof digest === "string" ? digest : undefined;
}

/** Brand `value` (a foreign error with a Next digest) as `brand`, so later checks are cheap. */
function adopt(value: object, brand: symbol): true {
  (value as Record<symbol, unknown>)[brand] = true;
  return true;
}

/** Whether `value` is a Next HTTP access error for `status` (or the legacy not-found one). */
function isNextAccessError(value: unknown, status: number): boolean {
  const digest = nextDigestOf(value);
  if (digest === undefined) return false;
  if (status === 404 && digest === "NEXT_NOT_FOUND") return true;
  return digest === `${HTTP_FALLBACK_DIGEST};${status}`;
}

/**
 * True if `value` is a {@link NotFoundError} raised by `notFound()`, or Next.js's own not-found
 * error (`digest` `NEXT_HTTP_ERROR_FALLBACK;404`) thrown by a library built for Next.
 */
export function isNotFound(value: unknown): value is NotFoundError {
  if (typeof value !== "object" || value === null) return false;
  if ((value as Record<symbol, unknown>)[NOT_FOUND] === true) return true;
  return isNextAccessError(value, 404) && adopt(value, NOT_FOUND);
}

// ---- forbidden() / unauthorized() ------------------------------------------

/** Brand symbol tagging {@link ForbiddenError} instances. */
const FORBIDDEN: symbol = /* @__PURE__ */ Symbol.for("denext.forbidden");
/** Brand symbol tagging {@link UnauthorizedError} instances. */
const UNAUTHORIZED: symbol = /* @__PURE__ */ Symbol.for("denext.unauthorized");

/** Error thrown by {@link forbidden} to render the nearest `forbidden` UI (HTTP 403). */
export class ForbiddenError extends Error {
  /** Brand flag identifying this as a forbidden signal. */
  declare readonly [FORBIDDEN]: true;
  /** Next.js's `digest` for the signal. */
  readonly digest: string = `${HTTP_FALLBACK_DIGEST};403`;
  /** Create a forbidden error. */
  constructor() {
    super("NEXT_FORBIDDEN");
    // Set here, not as a field: a computed field key pins the class into every bundle.
    (this as Record<symbol, unknown>)[FORBIDDEN] = true;
    this.name = "ForbiddenError";
  }
}

/** Error thrown by {@link unauthorized} to render the nearest `unauthorized` UI (HTTP 401). */
export class UnauthorizedError extends Error {
  /** Brand flag identifying this as an unauthorized signal. */
  declare readonly [UNAUTHORIZED]: true;
  /** Next.js's `digest` for the signal. */
  readonly digest: string = `${HTTP_FALLBACK_DIGEST};401`;
  /** Create an unauthorized error. */
  constructor() {
    super("NEXT_UNAUTHORIZED");
    // Set here, not as a field: a computed field key pins the class into every bundle.
    (this as Record<symbol, unknown>)[UNAUTHORIZED] = true;
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

/** True if `value` is a {@link ForbiddenError} raised by `forbidden()` (or Next's own). */
export function isForbidden(value: unknown): value is ForbiddenError {
  if (typeof value !== "object" || value === null) return false;
  if ((value as Record<symbol, unknown>)[FORBIDDEN] === true) return true;
  return isNextAccessError(value, 403) && adopt(value, FORBIDDEN);
}

/** True if `value` is an {@link UnauthorizedError} raised by `unauthorized()` (or Next's own). */
export function isUnauthorized(value: unknown): value is UnauthorizedError {
  if (typeof value !== "object" || value === null) return false;
  if ((value as Record<symbol, unknown>)[UNAUTHORIZED] === true) return true;
  return isNextAccessError(value, 401) && adopt(value, UNAUTHORIZED);
}

// ---- redirect() / permanentRedirect() --------------------------------------

/** Brand symbol tagging {@link RedirectError} instances. */
const REDIRECT: symbol = /* @__PURE__ */ Symbol.for("denext.redirect");

/**
 * `next/navigation`'s `RedirectType` — how a client-side (soft) navigation applies the
 * redirect: push a new history entry or replace the current one. Server responses ignore
 * it (they always issue an HTTP redirect).
 */
export enum RedirectType {
  push = "push",
  replace = "replace",
}

/** Error thrown by {@link redirect}/{@link permanentRedirect} to issue an HTTP redirect. */
export class RedirectError extends Error {
  /** Brand flag identifying this as a redirect signal. */
  declare readonly [REDIRECT]: true;
  /** Destination URL for the redirect. */
  readonly url: string;
  /** HTTP status code (307 temporary, 308 permanent). */
  readonly status: number;
  /** Client soft-nav history behavior (`push`/`replace`), when specified. */
  readonly redirectType?: RedirectType;
  /**
   * Next.js's `digest` for the signal (`NEXT_REDIRECT;<type>;<url>;<status>;`), which libraries
   * built for Next test for.
   */
  readonly digest: string;
  /** Create a redirect signal to `url` with the given `status` and optional soft-nav type. */
  constructor(url: string, status: number, redirectType?: RedirectType) {
    super(`NEXT_REDIRECT:${status}:${url}`);
    // Set here, not as a field: a computed field key pins the class into every bundle.
    (this as Record<symbol, unknown>)[REDIRECT] = true;
    this.name = "RedirectError";
    this.url = url;
    this.status = status;
    this.redirectType = redirectType;
    this.digest = `${REDIRECT_DIGEST};${redirectType ?? "replace"};${url};${status};`;
  }
}

/** The `digest` prefix of Next.js's redirect error. */
const REDIRECT_DIGEST = "NEXT_REDIRECT";

/**
 * Next.js's redirect error (`digest` `NEXT_REDIRECT;<type>;<url>;<status>;`, the URL may itself
 * contain `;`) as `{ url, status, type }`, or `undefined`.
 */
function parseNextRedirect(
  value: unknown,
): { url: string; status: number; type: string } | undefined {
  const parts = nextDigestOf(value)?.split(";");
  if (!parts || parts[0] !== REDIRECT_DIGEST || parts.length < 5) return undefined;
  const status = Number(parts.at(-2));
  const url = parts.slice(2, -2).join(";");
  if (!Number.isInteger(status) || status < 300 || status > 399 || url === "") return undefined;
  return { url, status, type: parts[1] };
}

/**
 * Throw to redirect to `url` from a component or action.
 *
 * Next's 2nd argument is a {@link RedirectType} (`push`/`replace`) controlling client
 * soft-nav history; denext additionally accepts a numeric HTTP status (its own
 * long-standing extension). A temporary redirect defaults to 307.
 *
 * @param url The destination.
 * @param typeOrStatus A {@link RedirectType} (soft-nav behavior) or an HTTP status number.
 */
export function redirect(
  url: Href | (string & Record<never, never>),
  typeOrStatus?: RedirectType | number,
): never {
  if (typeof typeOrStatus === "number") throw new RedirectError(url, typeOrStatus);
  throw new RedirectError(url, 307, typeOrStatus);
}

/**
 * Throw to issue a permanent (308) redirect to `url`.
 *
 * @param url The destination.
 * @param type Optional {@link RedirectType} for client soft-nav history behavior.
 */
export function permanentRedirect(
  url: Href | (string & Record<never, never>),
  type?: RedirectType,
): never {
  throw new RedirectError(url, 308, type);
}

/**
 * True if `value` is a {@link RedirectError} raised by `redirect()`, or Next.js's own redirect
 * error (a `NEXT_REDIRECT;…` digest) thrown by a library built for Next — which is then given
 * the `url` / `status` / `redirectType` a `RedirectError` has.
 */
export function isRedirect(value: unknown): value is RedirectError {
  if (typeof value !== "object" || value === null) return false;
  if ((value as Record<symbol, unknown>)[REDIRECT] === true) return true;
  const next = parseNextRedirect(value);
  if (!next) return false;
  Object.assign(value, {
    url: next.url,
    status: next.status,
    ...(next.type === "push" || next.type === "replace" ? { redirectType: next.type } : {}),
  });
  return adopt(value, REDIRECT);
}

/**
 * True for any denext control-flow signal (`notFound`/`forbidden`/`unauthorized`/
 * `redirect`) that error boundaries must re-throw rather than catch.
 */
export function isControlSignal(value: unknown): boolean {
  return isNotFound(value) || isForbidden(value) || isUnauthorized(value) ||
    isRedirect(value);
}

/**
 * Next's `unstable_rethrow` — re-throw denext's control-flow signals (`redirect()`,
 * `notFound()`, `forbidden()`, `unauthorized()`, a PPR postpone) from inside a
 * `try`/`catch`, so a catch-all handler doesn't swallow them. Also rethrows an Error whose
 * `cause` chain wraps such a signal (a library that re-wraps what it caught). A no-op for
 * any other value.
 */
export function unstable_rethrow(error: unknown): void {
  let e: unknown = error;
  for (let depth = 0; e !== undefined && depth < 8; depth++) {
    if (isControlSignal(e) || isPostpone(e)) throw error;
    e = e instanceof Error ? e.cause : undefined;
  }
}

/**
 * Brand for an error a boundary may receive UNREDACTED in production: it was thrown
 * to be rendered (a Remix `ErrorResponse`: status + data), not an internal failure.
 */
export const EXPOSE_ERROR: unique symbol = /* @__PURE__ */ Symbol.for(
  "denext.exposeError",
) as never;

/** Whether `value` is an Error flagged {@link EXPOSE_ERROR}. */
export function isExposedError(value: unknown): value is Error {
  return value instanceof Error &&
    (value as { [EXPOSE_ERROR]?: boolean })[EXPOSE_ERROR] === true;
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
  // An error built FOR the UI (a Remix thrown `Response` → status/data the boundary renders
  // as "not found") carries nothing to hide and is not a server failure: pass it through.
  if (isExposedError(error)) return error;
  const digest = errorDigest(error);
  console.error(`denext: server error [digest ${digest}]`, error);
  return Object.assign(new Error("Internal Server Error"), { digest });
}
