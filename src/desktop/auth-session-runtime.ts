/**
 * Deno Desktop OAuth sign-in, server half: the RFC 8252 loopback-redirect flow. On a
 * token-gated POST it opens the system browser at the (rewritten) authorization URL and binds a
 * one-shot `127.0.0.1` listener on an ephemeral port for the redirect, then answers the caller
 * with the captured callback URL.
 *
 * This is AUTH-CRITICAL. Every check fails closed, the token compare is constant-time, and the
 * code/state carried in the auth and callback URLs are NEVER logged.
 *
 * Runs in the Deno process (Deno APIs OK). The browser half lives in `./auth-session.ts`.
 *
 * @module
 */

import type { AuthSessionErrorCode } from "../mobile/auth-session.ts";
import {
  type DesktopServeInfo,
  type DesktopTrust,
  LOOPBACK_TRUST,
  memoryGate,
} from "./transport.ts";

/**
 * Which desktop world a request is judged in ({@link resolveDesktopTrust}) and the `Deno.serve`
 * info it arrived with. Omitted, the stock runtime's loopback rules apply.
 */
export interface DesktopRequestAccess {
  readonly trust: DesktopTrust;
  readonly info?: DesktopServeInfo;
}

/** Default timeout: 5 minutes (RFC 8252 loopback flows are user-interactive). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** The static, script-free page shown in the browser tab after the redirect lands. */
const SUCCESS_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  "<title>Signed in</title></head><body><p>You can close this tab.</p></body></html>";

/** One session at a time (this process); a second concurrent call gets `busy`. */
let busy = false;
/** Ends the open session as `cancelled` (set while one is open). */
let cancelOpen: (() => void) | undefined;
/** What the open session's wait resolves with when the page cancels it. */
const CANCELLED = Symbol("cancelled");

/** A structured JSON error envelope the client half maps back to an `AuthSessionError`. */
function fail(status: number, code: AuthSessionErrorCode, message: string): Response {
  return Response.json({ code, message }, { status });
}

/**
 * The response for a disabled auth-session capability: `{ code: "unavailable" }`, which the
 * page-side {@link openAuthSession} recognizes (it maps `unavailable` to an `unsupported` error
 * telling the developer to run `denext desktop add auth-session`). Returned by the desktop handler
 * BEFORE {@link handleDesktopAuthSession}, so the system browser is never opened — and the
 * `--allow-run` for the opener is only baked when the capability is enabled. `unavailable` is the
 * bridge's reserved "not enabled" code, so it is sent directly rather than as an
 * {@link AuthSessionErrorCode}.
 */
export function authSessionUnavailable(): Response {
  return Response.json(
    { code: "unavailable", message: "the auth-session capability is not enabled" },
    { status: 404 },
  );
}

/**
 * Constant-time string compare over UTF-8 bytes. Returns false immediately when the lengths
 * differ (length is not secret here — the token is a fixed-length UUID), otherwise XOR-accumulates
 * every byte so no character short-circuits the comparison.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Whether `origin` is a loopback http origin (`http://127.0.0.1|localhost|[::1]:*`). */
function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
}

/**
 * Whether `uri` is a loopback http redirect URI: scheme `http:`, host `127.0.0.1` / `[::1]` /
 * `localhost`, and NO fragment (RFC 8252 §7.3 — the fragment must not carry the response).
 */
function isLoopbackRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.hash !== "") return false;
  return u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost";
}

/**
 * The launcher command + argv to open `url` in the default browser, per OS. The URL is ALWAYS a
 * single argv entry, never a shell string. On Windows this must NOT be `cmd /c start <url>`:
 * `cmd.exe` parses `&` as a command separator, so an OAuth URL (`…?client_id=x&redirect_uri=…&
 * state=…`) would be truncated at the first `&` and the tail run as commands — a command-injection
 * sink. `rundll32 url.dll,FileProtocolHandler <url>` hands the whole URL to the default handler as
 * one un-parsed argument. Exported for testing.
 */
export function browserLaunchArgs(os: typeof Deno.build.os, url: string): [string, string[]] {
  if (os === "darwin") return ["open", [url]];
  if (os === "windows") return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/**
 * Open `url` in the system browser: the per-OS launcher of {@linkcode browserLaunchArgs}, the URL
 * as one argv entry, never a shell string. The default opener of both desktop auth-session flows.
 *
 * @param url The authorization URL.
 */
export async function defaultOpenBrowser(url: string): Promise<void> {
  const [cmd, args] = browserLaunchArgs(Deno.build.os, url);
  await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output();
}

/**
 * Validate a desktop auth-session request, failing closed in order: POST (405), constant-time
 * token (403), loopback `Origin` (403), JSON content-type (415), and a JSON body whose `authUrl`
 * is an absolute `https:` URL with a loopback, fragment-less `redirect_uri` and an optional
 * positive `timeoutMs` (400 `invalid`). Returns the parsed inputs, or the error {@link Response}.
 */
/**
 * Where the request came from (403 when refused). Memory world: the in-process memory transport
 * and an `Origin` that is absent or exactly the app origin. Loopback world: an `Origin` equal to
 * the desktop server's OWN loopback origin (this request's), not just any loopback — so another
 * local app's dev server on a different port can't reach the endpoint.
 */
function authPlace(request: Request, access: DesktopRequestAccess): Response | null {
  const { trust } = access;
  if (trust.kind === "refuse") return fail(403, "unsupported", "desktop runtime not trusted");
  if (trust.kind === "memory") {
    const why = memoryGate(trust, request, access.info);
    if (why === null) return null;
    return fail(403, "unsupported", `bad ${why}`);
  }
  const origin = request.headers.get("origin");
  const selfOrigin = new URL(request.url).origin;
  if (origin === null || origin !== selfOrigin || !isLoopbackOrigin(origin)) {
    return fail(403, "unsupported", "bad origin");
  }
  return null;
}

/** Method (405), constant-time token (403), where-from (403), JSON content-type (415). */
function validateAuthHeaders(
  request: Request,
  token: string,
  access: DesktopRequestAccess,
): Response | null {
  if (request.method !== "POST") return fail(405, "unsupported", "method not allowed");
  // Constant-time compare, no early return on a mismatched byte.
  const presented = request.headers.get("x-denext-desktop-token") ?? "";
  if (!timingSafeEqual(presented, token)) return fail(403, "unsupported", "bad token");
  const place = authPlace(request, access);
  if (place) return place;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return fail(415, "unsupported", "content-type must be application/json");
  }
  return null;
}

/** A parsed start request. */
interface AuthStart {
  authUrl: URL;
  redirectUri: URL;
  timeoutMs: number | undefined;
}

/** The JSON body: `{ cancel: true }` (end the open session), or an https `authUrl` with a
 * loopback, fragment-less `redirect_uri` + optional positive `timeoutMs` (all 400 `invalid`).
 * Returns the parsed inputs or the error Response. */
async function parseAuthBody(request: Request): Promise<AuthStart | { cancel: true } | Response> {
  let payload: { authUrl?: unknown; timeoutMs?: unknown; cancel?: unknown };
  try {
    payload = await request.json();
  } catch {
    return fail(400, "invalid", "body must be JSON");
  }
  if (payload?.cancel === true) return { cancel: true };
  const { authUrl, timeoutMs } = payload ?? {};

  let authParsed: URL;
  try {
    authParsed = new URL(typeof authUrl === "string" ? authUrl : "");
  } catch {
    return fail(400, "invalid", "authUrl must be an absolute https: URL");
  }
  if (authParsed.protocol !== "https:") {
    return fail(400, "invalid", "authUrl must be an absolute https: URL");
  }
  const redirectUriStr = authParsed.searchParams.get("redirect_uri");
  if (redirectUriStr === null || !isLoopbackRedirect(redirectUriStr)) {
    return fail(400, "invalid", "redirect_uri must be a loopback http: URI without a fragment");
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    return fail(400, "invalid", "timeoutMs must be a positive number of milliseconds");
  }
  return {
    authUrl: authParsed,
    redirectUri: new URL(redirectUriStr),
    timeoutMs: timeoutMs as number | undefined,
  };
}

async function validateAuthRequest(
  request: Request,
  token: string,
  access: DesktopRequestAccess,
): Promise<AuthStart | { cancel: true } | Response> {
  return validateAuthHeaders(request, token, access) ?? await parseAuthBody(request);
}

/**
 * Handle a desktop auth-session request: validate, open the system browser, and run a one-shot
 * loopback listener for the OAuth redirect. `openBrowser` is injectable for tests; the default
 * launches the system browser.
 *
 * Validation runs in order, each failing closed:
 * 1. method `POST`, else 405;
 * 2. `x-denext-desktop-token` constant-time-equal to `token`, else 403;
 * 3. where from, else 403: in the loopback world an `Origin` equal to this server's own loopback
 *    origin; in the memory world the memory transport and an `Origin` absent or equal to the app
 *    origin ({@link DesktopRequestAccess});
 * 4. `content-type` starts with `application/json`, else 415;
 * 5. body `{ authUrl, timeoutMs? }`: `authUrl` parses and is `https:` with a loopback,
 *    fragment-less `redirect_uri`, and `timeoutMs` (if present) is a positive finite number,
 *    else 400 `{code:"invalid"}`.
 *
 * Then a single-session guard (409 `{code:"busy"}`), the loopback listener, and a timeout
 * (408 `{code:"timeout"}`). On success: 200 `{ url }`.
 *
 * A body of `{ cancel: true }` (behind the same checks 1–4) ends the open session instead: the
 * page's cancel, since the system browser reports no cancellation. That session answers 499
 * `{code:"cancelled"}`, and the cancel request 200 `{ cancelled }` (whether one was open).
 */
export async function handleDesktopAuthSession(
  request: Request,
  token: string,
  openBrowser: (url: string) => Promise<void> | void = defaultOpenBrowser,
  access: DesktopRequestAccess = { trust: LOOPBACK_TRUST },
): Promise<Response> {
  const parsed = await validateAuthRequest(request, token, access);
  if (parsed instanceof Response) return parsed;
  if ("cancel" in parsed) {
    const open = cancelOpen;
    open?.();
    return Response.json({ cancelled: open !== undefined });
  }
  const { authUrl: authParsed, redirectUri, timeoutMs } = parsed;

  // Single session.
  if (busy) return fail(409, "busy", "another desktop auth session is still open");
  busy = true;

  const redirectPath = redirectUri.pathname;
  let server: Deno.HttpServer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const callbackUrl = await new Promise<string | null | typeof CANCELLED>((resolve) => {
      cancelOpen = () => resolve(CANCELLED);
      server = Deno.serve(
        {
          hostname: "127.0.0.1",
          port: 0,
          // Silence the default "Listening on…" line; keep the port off any log.
          onListen: () => {},
          onError: () => new Response(null, { status: 500 }),
        },
        (req) => {
          const path = new URL(req.url).pathname;
          if (path !== redirectPath) return new Response("not found", { status: 404 });
          // The code/state ride the query on a loopback redirect — capture the whole URL.
          resolve(req.url);
          return new Response(SUCCESS_HTML, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": "default-src 'none'",
            },
          });
        },
      );

      const port = (server.addr as Deno.NetAddr).port;
      // Rewrite ONLY the redirect_uri host+port to the chosen loopback port; keep its path/query.
      const rewrittenRedirect = new URL(redirectUri.href);
      rewrittenRedirect.hostname = "127.0.0.1";
      rewrittenRedirect.port = String(port);
      const rewrittenAuth = new URL(authParsed.href);
      rewrittenAuth.searchParams.set("redirect_uri", rewrittenRedirect.href);

      timer = setTimeout(() => resolve(null), timeoutMs ?? DEFAULT_TIMEOUT_MS);

      // Fire-and-forget: never surface the (secret-bearing) auth URL through a rejection.
      Promise.resolve().then(() => openBrowser(rewrittenAuth.href)).catch(() => {});
    });

    if (callbackUrl === null) {
      return fail(408, "timeout", "no OAuth redirect within the timeout");
    }
    if (callbackUrl === CANCELLED) return fail(499, "cancelled", "the sign-in was cancelled");
    return Response.json({ url: callbackUrl });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cancelOpen = undefined;
    if (server) await server.shutdown().catch(() => {});
    busy = false;
  }
}

/** Forget the module's single-session flag (tests only). */
export function resetDesktopAuthSessionForTesting(): void {
  busy = false;
  cancelOpen = undefined;
}
