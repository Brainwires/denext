// The six-layer local security model of `denext ui`. The UI is a *state-writing* local web
// server, so it is defended like one even though it only ever listens on loopback:
//
//   1. bind          — `127.0.0.1` only, never `--host` (enforced in `server.ts`).
//   2. host/origin   — {@linkcode uiOriginAllowed}: the Host the browser sent must be a loopback
//                      name (DNS-rebinding defence, cf. CVE-2025-48068) and a present
//                      `Sec-Fetch-Site` must say `same-origin`. Mirrors the dev server's
//                      `devOriginAllowed` rule; re-implemented here (with no `allowedDevOrigins`
//                      list, which the UI has no concept of) because
//                      `src/build/dev-server/dev-endpoints.ts` transitively imports esbuild and
//                      `denext ui` must never load the bundler.
//   3. session token — a per-launch 256-bit token handed over once in `?t=` and exchanged for an
//                      `HttpOnly; SameSite=Strict` cookie ({@linkcode handshake}); every request
//                      without it is a 401 ({@linkcode authorized}).
//   4. CSRF          — a mutation additionally needs `verifyOrigin` plus a token derived as
//                      HMAC-SHA256(sessionToken, "csrf") ({@linkcode checkCsrf}).
//   5. containment   — {@linkcode uiSafeJoin} for every project-relative path (lexical + realpath).
//   6. headers       — {@linkcode applySecurityHeaders}: strict CSP, COOP/CORP, no-referrer,
//                      no-store.
//
// `--read-only` refuses every mutation before any of it runs.

import { isAbsolute, relative, resolve } from "@std/path";
import { verifyOrigin } from "../server/origin-check.ts";

/** The cookie the session token is parked in after the `?t=` handshake. */
export const UI_COOKIE = "denext_ui_token";

/** The header a JSON (non-form) mutation carries its CSRF token in. */
export const UI_CSRF_HEADER = "x-denext-ui-csrf";

/** The hidden form field a no-JS mutation carries its CSRF token in. */
export const UI_CSRF_FIELD = "_csrf";

/** The exact response header set every UI response carries. */
const UI_HEADERS: readonly (readonly [string, string])[] = [
  [
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  ],
  ["referrer-policy", "no-referrer"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
  ["cache-control", "no-store"],
  ["x-content-type-options", "nosniff"],
];

/** One launch's credentials. */
export interface UiSession {
  /** The 256-bit bearer token (base64url) handed over in `?t=` and stored in the cookie. */
  readonly token: string;
  /** The CSRF token derived from it; every mutation must present this. */
  readonly csrf: string;
}

/**
 * Mint (or adopt) the credentials for one `denext ui` launch.
 *
 * @param token An explicit `--token`; a fresh 256-bit token is generated when omitted.
 * @returns The session token and its derived CSRF token.
 */
export async function createUiSession(token?: string): Promise<UiSession> {
  const value = token && token.length > 0 ? token : newToken();
  return { token: value, csrf: await deriveCsrf(value) };
}

/**
 * A fresh 256-bit URL-safe token.
 *
 * @returns 43 base64url characters of `crypto.getRandomValues` entropy.
 */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The CSRF token for a session: HMAC-SHA256 of the literal `"csrf"` under the session token.
 * Deriving (rather than minting a second random value) keeps the pair inseparable, so a token
 * leaked through the URL bar is the only secret there is to reason about.
 *
 * @param token The session token.
 * @returns The derived CSRF token (base64url).
 */
export async function deriveCsrf(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("csrf") as BufferSource,
  );
  return base64url(new Uint8Array(sig));
}

/** URL-safe, unpadded base64 of `bytes`. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Length-independent, constant-time string comparison (no early exit on the first differing
 * character, and unequal lengths still walk the full loop).
 *
 * @param a First value.
 * @param b Second value.
 * @returns Whether the two are identical.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

// ── layer 2: host + origin ───────────────────────────────────────────────────

/**
 * May this request reach the UI at all? The Host header must name a loopback interface (so a
 * hostname an attacker controls that resolves to 127.0.0.1 cannot be "same-origin" with the UI
 * in a browser's eyes), and a browser-supplied `Sec-Fetch-Site` must read `same-origin` — which
 * also refuses the Origin-less cross-site subresource load.
 *
 * @param request The incoming request.
 * @param url Its parsed URL.
 * @returns Whether to proceed (a `false` is a 403).
 */
export function uiOriginAllowed(request: Request, url: URL): boolean {
  if (!loopbackHost(url.hostname)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl / tests — no ambient-credential risk
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false; // malformed Origin
  }
}

/** Whether `hostname` (possibly a bracketed IPv6 literal) names the loopback interface. */
function loopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

// ── layer 3: the token handshake ─────────────────────────────────────────────

/**
 * The `?t=<token>` handshake: on a valid token, park it in an `HttpOnly; SameSite=Strict` cookie
 * and 302 to the same path **without** the query, so the secret never survives in the address
 * bar, `document.referrer`, history, or a copied link.
 *
 * @param url The parsed request URL.
 * @param session The launch credentials.
 * @returns The redirect, or `null` when the request carried no `?t=` to exchange.
 */
export function handshake(url: URL, session: UiSession): Response | null {
  const presented = url.searchParams.get("t");
  if (presented === null) return null;
  if (!constantTimeEqual(presented, session.token)) {
    return new Response(JSON.stringify({ ok: false, reason: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const clean = new URL(url.href);
  clean.searchParams.delete("t");
  const location = clean.pathname + (clean.search === "?" ? "" : clean.search);
  const headers = new Headers({ location });
  headers.append(
    "set-cookie",
    `${UI_COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/`,
  );
  return new Response(null, { status: 302, headers });
}

/**
 * Is the session cookie present and correct?
 *
 * @param request The incoming request.
 * @param session The launch credentials.
 * @returns Whether the caller is authenticated.
 */
export function authorized(request: Request, session: UiSession): boolean {
  const cookie = readCookie(request.headers.get("cookie"), UI_COOKIE);
  return cookie !== null && constantTimeEqual(cookie, session.token);
}

/** The value of `name` in a `Cookie` header, or `null`. */
function readCookie(header: string | null, name: string): string | null {
  const prefix = `${name}=`;
  const hit = (header ?? "").split(/;\s*/).find((part) => part.startsWith(prefix));
  return hit === undefined ? null : hit.trim().slice(prefix.length);
}

// ── layer 4: CSRF ────────────────────────────────────────────────────────────

/**
 * The CSRF gate for a mutation: a same-origin `Origin`/`Referer` (`verifyOrigin`, the same check
 * denext applies to Server Actions) plus the derived token, from the header or the hidden field.
 *
 * @param request The incoming request.
 * @param url Its parsed URL.
 * @param session The launch credentials.
 * @param form The decoded form body, when the mutation carried one.
 * @returns `null` when the mutation may proceed, else the refusal reason.
 */
export function checkCsrf(
  request: Request,
  url: URL,
  session: UiSession,
  form?: FormData,
): string | null {
  if (!verifyOrigin(request, { canonicalOrigin: url.origin })) return "bad origin";
  const header = request.headers.get(UI_CSRF_HEADER);
  const field = form?.get(UI_CSRF_FIELD);
  const presented = header ?? (typeof field === "string" ? field : null);
  if (presented === null || !constantTimeEqual(presented, session.csrf)) return "bad csrf token";
  return null;
}

// ── layer 5: containment ─────────────────────────────────────────────────────

/**
 * Join a project-relative path under `root` and refuse to escape it. Lexical first (`..`,
 * absolute paths), then a realpath re-check of the deepest existing ancestor, so a symlink
 * *inside* the project cannot point the UI at a file outside it.
 *
 * @param root The project directory.
 * @param rel The project-relative path the browser asked for.
 * @returns The absolute path, guaranteed to be inside `root`.
 * @throws When the path escapes the project (a `denext:`-prefixed error).
 */
export async function uiSafeJoin(root: string, rel: string): Promise<string> {
  const base = resolve(root);
  if (isAbsolute(rel)) throw escapeError(rel);
  const target = resolve(base, rel);
  const r = relative(base, target);
  if (r === ".." || r.startsWith(".." + "/") || r.startsWith(".." + "\\")) throw escapeError(rel);
  const realBase = await Deno.realPath(base);
  if (!within(await realPathOfNearest(target), realBase)) throw escapeError(rel);
  return target;
}

/** The realpath of `path`, or of its nearest existing ancestor when it does not exist yet. */
async function realPathOfNearest(path: string): Promise<string> {
  let current = path;
  for (let i = 0; i < 64; i++) {
    try {
      return await Deno.realPath(current);
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) return current;
      current = parent;
    }
  }
  return current;
}

/** Whether `p` is `dir` itself or lives under it. */
function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + "/") || p.startsWith(dir + "\\");
}

/** The refusal thrown by {@linkcode uiSafeJoin}. */
function escapeError(rel: string): Error {
  return new Error(
    `denext: ui refuses to touch a path outside the project (${rel}).`,
  );
}

// ── layer 6: headers ─────────────────────────────────────────────────────────

/**
 * Stamp the UI's fixed header set onto a response (in place; the same response is returned).
 *
 * @param response The response to harden.
 * @returns The same response.
 */
export function applySecurityHeaders(response: Response): Response {
  for (const [name, value] of UI_HEADERS) response.headers.set(name, value);
  return response;
}
