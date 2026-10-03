/**
 * Server side of Next.js control-flow interop: recognize the errors a library built for Next
 * throws ITSELF in Next's format — a plain Error with a `digest` (`@clerk/nextjs`'s
 * `auth.protect()` throws `NEXT_REDIRECT;replace;<url>;307;` and
 * `NEXT_HTTP_ERROR_FALLBACK;404`) — as denext's own `redirect()` / `notFound()` / `forbidden()`
 * / `unauthorized()` signals. A recognized error is adopted: branded like denext's (later checks
 * are a property read) and, for a redirect, given the `url` / `status` / `redirectType` a
 * `RedirectError` has.
 *
 * Installed on globalThis at import (every copy of `src/runtime/error-boundary.ts` — the one in a
 * next-compat bundle too — consults it there); the browser never loads this module, so client
 * bundles carry none of it. The other direction (denext's signals carrying Next's digest) lives on
 * the error classes themselves.
 *
 * @module
 */

/** The access-error statuses per signal (`NEXT_HTTP_ERROR_FALLBACK;<status>`). */
const ACCESS_STATUS = { notFound: 404, forbidden: 403, unauthorized: 401 } as const;

/** The brand each signal's errors carry (`Symbol.for`, as in `error-boundary.ts`). */
const BRAND = {
  notFound: Symbol.for("denext.notFound"),
  forbidden: Symbol.for("denext.forbidden"),
  unauthorized: Symbol.for("denext.unauthorized"),
  redirect: Symbol.for("denext.redirect"),
} as const;

/** A signal kind. */
type SignalKind = keyof typeof BRAND;

/** The `digest` string of `value`, or undefined. */
function digestOf(value: object): string | undefined {
  const digest = (value as { digest?: unknown }).digest;
  return typeof digest === "string" ? digest : undefined;
}

/**
 * Next's redirect digest (`NEXT_REDIRECT;<type>;<url>;<status>;`, the URL may itself contain `;`)
 * as `{ url, status, type }`, or undefined.
 *
 * @param digest A `digest` string.
 * @returns The parts, or undefined when it is not a redirect digest with a 3xx status.
 */
export function parseNextRedirectDigest(
  digest: string,
): { url: string; status: number; type: string } | undefined {
  const parts = digest.split(";");
  if (parts[0] !== "NEXT_REDIRECT" || parts.length < 5) return undefined;
  const status = Number(parts.at(-2));
  const url = parts.slice(2, -2).join(";");
  if (!Number.isInteger(status) || status < 300 || status > 399 || url === "") return undefined;
  return { url, status, type: parts[1] };
}

/**
 * Whether `value` is a library's Next-format error for `kind`; when it is, it is adopted (see
 * the module docs).
 *
 * @param value A thrown value (an object).
 * @param kind The signal asked about.
 * @returns `true` for a match.
 */
function recognizeNextSignal(value: object, kind: SignalKind): boolean {
  const digest = digestOf(value);
  if (digest === undefined) return false;
  if (kind === "redirect") {
    const next = parseNextRedirectDigest(digest);
    if (!next) return false;
    Object.assign(value, {
      url: next.url,
      status: next.status,
      ...(next.type === "push" || next.type === "replace" ? { redirectType: next.type } : {}),
    });
  } else {
    const status = ACCESS_STATUS[kind];
    const legacy = kind === "notFound" && digest === "NEXT_NOT_FOUND";
    if (!legacy && digest !== `NEXT_HTTP_ERROR_FALLBACK;${status}`) return false;
  }
  (value as Record<symbol, unknown>)[BRAND[kind]] = true;
  return true;
}

(globalThis as { [k: symbol]: unknown })[Symbol.for("denext.foreignSignals")] = recognizeNextSignal;
