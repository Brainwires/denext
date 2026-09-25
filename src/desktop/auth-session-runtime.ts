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

/** Default timeout: 5 minutes (RFC 8252 loopback flows are user-interactive). */
const DEFAULT_TIMEOUT_MS = 300_000;

/** The static, script-free page shown in the browser tab after the redirect lands. */
const SUCCESS_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  "<title>Signed in</title></head><body><p>You can close this tab.</p></body></html>";

/** One session at a time (this process); a second concurrent call gets `busy`. */
let busy = false;

/** A structured JSON error envelope the client half maps back to an `AuthSessionError`. */
function fail(status: number, code: AuthSessionErrorCode, message: string): Response {
  return Response.json({ code, message }, { status });
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

/** Default `openBrowser`: hand the URL to the OS browser as an argv arg — never a shell string. */
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

async function defaultOpenBrowser(url: string): Promise<void> {
  const [cmd, args] = browserLaunchArgs(Deno.build.os, url);
  await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output();
}

/**
 * Validate a desktop auth-session request, failing closed in order: POST (405), constant-time
 * token (403), loopback `Origin` (403), JSON content-type (415), and a JSON body whose `authUrl`
 * is an absolute `https:` URL with a loopback, fragment-less `redirect_uri` and an optional
 * positive `timeoutMs` (400 `invalid`). Returns the parsed inputs, or the error {@link Response}.
 */
/** Method (405), constant-time token (403), loopback Origin (403), JSON content-type (415). */
function validateAuthHeaders(request: Request, token: string): Response | null {
  if (request.method !== "POST") return fail(405, "unsupported", "method not allowed");
  // Constant-time compare, no early return on a mismatched byte.
  const presented = request.headers.get("x-denext-desktop-token") ?? "";
  if (!timingSafeEqual(presented, token)) return fail(403, "unsupported", "bad token");
  // Exact-origin: the Origin must equal the desktop server's OWN origin (this request's), not just
  // any loopback — so another local app's dev server on a different port can't reach the endpoint.
  const origin = request.headers.get("origin");
  const selfOrigin = new URL(request.url).origin;
  if (origin === null || origin !== selfOrigin || !isLoopbackOrigin(origin)) {
    return fail(403, "unsupported", "bad origin");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return fail(415, "unsupported", "content-type must be application/json");
  }
  return null;
}

/** The JSON body: an https `authUrl` with a loopback, fragment-less `redirect_uri` + optional
 * positive `timeoutMs` (all 400 `invalid`). Returns the parsed inputs or the error Response. */
async function parseAuthBody(
  request: Request,
): Promise<{ authUrl: URL; redirectUri: URL; timeoutMs: number | undefined } | Response> {
  let payload: { authUrl?: unknown; timeoutMs?: unknown };
  try {
    payload = await request.json();
  } catch {
    return fail(400, "invalid", "body must be JSON");
  }
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
): Promise<{ authUrl: URL; redirectUri: URL; timeoutMs: number | undefined } | Response> {
  return validateAuthHeaders(request, token) ?? await parseAuthBody(request);
}

/**
 * Handle a desktop auth-session request: validate, open the system browser, and run a one-shot
 * loopback listener for the OAuth redirect. `openBrowser` is injectable for tests; the default
 * launches the system browser.
 *
 * Validation runs in order, each failing closed:
 * 1. method `POST`, else 405;
 * 2. `x-denext-desktop-token` constant-time-equal to `token`, else 403;
 * 3. `Origin` present and a loopback origin, else 403;
 * 4. `content-type` starts with `application/json`, else 415;
 * 5. body `{ authUrl, timeoutMs? }`: `authUrl` parses and is `https:` with a loopback,
 *    fragment-less `redirect_uri`, and `timeoutMs` (if present) is a positive finite number,
 *    else 400 `{code:"invalid"}`.
 *
 * Then a single-session guard (409 `{code:"busy"}`), the loopback listener, and a timeout
 * (408 `{code:"timeout"}`). On success: 200 `{ url }`.
 */
export async function handleDesktopAuthSession(
  request: Request,
  token: string,
  openBrowser: (url: string) => Promise<void> | void = defaultOpenBrowser,
): Promise<Response> {
  const parsed = await validateAuthRequest(request, token);
  if (parsed instanceof Response) return parsed;
  const { authUrl: authParsed, redirectUri, timeoutMs } = parsed;

  // Single session.
  if (busy) return fail(409, "busy", "another desktop auth session is still open");
  busy = true;

  const redirectPath = redirectUri.pathname;
  let server: Deno.HttpServer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const callbackUrl = await new Promise<string | null>((resolve) => {
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
    return Response.json({ url: callbackUrl });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (server) await server.shutdown().catch(() => {});
    busy = false;
  }
}

/** Forget the module's single-session flag (tests only). */
export function resetDesktopAuthSessionForTesting(): void {
  busy = false;
}
