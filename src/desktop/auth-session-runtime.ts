/**
 * Deno Desktop OAuth sign-in, server half: the RFC 8252 loopback-redirect flow. On a
 * token-gated POST it opens the system browser at the (rewritten) authorization URL and binds a
 * one-shot listener for the redirect on `127.0.0.1` and `::1` (RFC 8252 §7.3; IPv4 alone on a host
 * without IPv6) on one ephemeral port — or, with `loopbackPort`, on that fixed port (a provider
 * that only accepts its registered `http://localhost:1455/…`) — then answers the caller with the
 * captured callback URL, once one carries the authorization URL's `state`.
 *
 * The authorization URL must carry PKCE S256 (RFC 7636), as on every `openAuthSession` path, unless
 * the caller waives it with `pkce: "not-applicable"` and a `reason`: another local process can
 * hold or race the loopback port and take the redirect (RFC 8252 §8.1), and only the verifier the
 * page kept makes the `code` it carries redeemable.
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
/** The open session's key (the starting page's), which a cancel must name; none for a keyless start. */
let openSessionKey: string | undefined;
/** A session key: what the starting page keeps to cancel its own session. */
const SESSION_KEY = /^[A-Za-z0-9-]{16,128}$/;
/** What the open session's wait resolves with when the page cancels it. */
const CANCELLED = Symbol("cancelled");

/** A PKCE S256 `code_challenge`: base64url(SHA-256), 43 characters, no padding (RFC 7636 §4.2). */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** The longest `reason` kept for a `pkce: "not-applicable"` session. */
const MAX_PKCE_REASON = 500;

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
  // The normalized href (a URL the callers already validated as absolute https).
  const [cmd, args] = browserLaunchArgs(Deno.build.os, new URL(url).href);
  await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output();
}

/**
 * Validate a desktop auth-session request, failing closed in order: POST (405), constant-time
 * token (403), loopback `Origin` (403), JSON content-type (415), and a JSON body whose `authUrl`
 * is an absolute `https:` URL with a loopback, fragment-less `redirect_uri`, PKCE S256 (400
 * `pkce_required`) and an optional positive `timeoutMs` (400 `invalid`). Returns the parsed
 * inputs, or the error {@link Response}.
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
  /** The fixed loopback port (RFC 8252 §7.3 allows one), else an ephemeral port is chosen. */
  loopbackPort?: number;
  /** The starting page's session key (its cancel must name it). */
  session?: string;
  /** The `authUrl`'s `state`, which the callback must carry back byte for byte; `null`: none. */
  state: string | null;
}

/** A cancel request, naming the session it ends. */
interface AuthCancel {
  cancel: true;
  session?: string;
}

/**
 * The `loopbackPort` of a start request: absent, or an integer port the `redirect_uri` agrees
 * with (its port absent or the same). A `Response` (400 `invalid`) when it is not.
 */
function parseLoopbackPort(raw: unknown, redirectUri: URL): number | undefined | Response {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    return fail(400, "invalid", "loopbackPort must be an integer port from 1 to 65535");
  }
  if (redirectUri.port !== "" && Number(redirectUri.port) !== raw) {
    return fail(400, "invalid", `redirect_uri names port ${redirectUri.port}, not ${raw}`);
  }
  return raw;
}

/** The JSON body: `{ cancel: true }` (end the open session), or an https `authUrl` with a
 * loopback, fragment-less `redirect_uri` + optional positive `timeoutMs` (all 400 `invalid`).
 * Returns the parsed inputs or the error Response. */
async function parseAuthBody(request: Request): Promise<AuthStart | AuthCancel | Response> {
  let payload: AuthPayload;
  try {
    payload = await request.json() ?? {};
  } catch {
    return fail(400, "invalid", "body must be JSON");
  }
  const session = payload.session;
  if (session !== undefined && (typeof session !== "string" || !SESSION_KEY.test(session))) {
    return fail(400, "invalid", "session must be a 16–128 character key");
  }
  if (payload.cancel === true) {
    return session === undefined ? { cancel: true } : { cancel: true, session };
  }
  const start = parseAuthStart(payload);
  if (start instanceof Response) return start;
  return session === undefined ? start : { ...start, session };
}

/** A start or cancel request's JSON body, as received. */
interface AuthPayload {
  authUrl?: unknown;
  timeoutMs?: unknown;
  cancel?: unknown;
  loopbackPort?: unknown;
  session?: unknown;
  pkce?: unknown;
  reason?: unknown;
}

/** The `authUrl` as an absolute https URL with a loopback `redirect_uri`, or the 400. */
function parseAuthUrl(authUrl: unknown): { authUrl: URL; redirectUri: URL } | Response {
  let parsed: URL;
  try {
    parsed = new URL(typeof authUrl === "string" ? authUrl : "");
  } catch {
    return fail(400, "invalid", "authUrl must be an absolute https: URL");
  }
  if (parsed.protocol !== "https:") {
    return fail(400, "invalid", "authUrl must be an absolute https: URL");
  }
  if (parsed.searchParams.getAll("state").length > 1) {
    return fail(400, "invalid", "the URL carries state more than once");
  }
  const redirect = parsed.searchParams.get("redirect_uri");
  if (redirect === null || !isLoopbackRedirect(redirect)) {
    return fail(400, "invalid", "redirect_uri must be a loopback http: URI without a fragment");
  }
  return { authUrl: parsed, redirectUri: new URL(redirect) };
}

/** The single value of a query parameter, or `null` when it is absent or repeated. */
function singleParam(url: URL, name: string): string | null {
  const all = url.searchParams.getAll(name);
  return all.length === 1 ? all[0] : null;
}

/**
 * PKCE S256 in the authorization URL (RFC 7636; RFC 8252 §8.1 makes it the loopback flow's defence
 * against another local process taking the redirect): one `code_challenge` (a SHA-256's base64url)
 * and one `code_challenge_method=S256`, unless `pkce: "not-applicable"` with a `reason` — the same
 * rule as every other `openAuthSession` path. `null` when it holds, else the 400.
 */
function pkceRefusal(authUrl: URL, payload: AuthPayload): Response | null {
  if (payload.pkce !== undefined) {
    return pkceWaiverRefusal(payload) ??
      (singleParam(authUrl, "state") === null
        ? fail(400, "invalid", 'pkce: "not-applicable" needs a state the callback must carry')
        : null);
  }
  if (
    S256_CHALLENGE.test(singleParam(authUrl, "code_challenge") ?? "") &&
    singleParam(authUrl, "code_challenge_method") === "S256"
  ) return null;
  return fail(
    400,
    "pkce_required",
    "the URL must carry PKCE: one code_challenge (a 43-character base64url SHA-256) and " +
      'code_challenge_method=S256 (or pass pkce: "not-applicable" with a reason)',
  );
}

/** A `pkce` waiver: `"not-applicable"` with a non-empty, bounded `reason`, else the 400 `invalid`. */
function pkceWaiverRefusal({ pkce, reason }: AuthPayload): Response | null {
  if (pkce !== "not-applicable") {
    return fail(400, "invalid", 'pkce must be "not-applicable" when given');
  }
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text !== "" && text.length <= MAX_PKCE_REASON) return null;
  return fail(
    400,
    "invalid",
    'pkce: "not-applicable" needs a reason (how the provider binds the callback)',
  );
}

/** A start request's inputs (everything but the session key), or the 400. */
function parseAuthStart(payload: AuthPayload): AuthStart | Response {
  const urls = parseAuthUrl(payload.authUrl);
  if (urls instanceof Response) return urls;
  const pkce = pkceRefusal(urls.authUrl, payload);
  if (pkce) return pkce;
  const { timeoutMs } = payload;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    return fail(400, "invalid", "timeoutMs must be a positive number of milliseconds");
  }
  const loopbackPort = parseLoopbackPort(payload.loopbackPort, urls.redirectUri);
  if (loopbackPort instanceof Response) return loopbackPort;
  return {
    ...urls,
    state: singleParam(urls.authUrl, "state"),
    timeoutMs: timeoutMs as number | undefined,
    ...(loopbackPort !== undefined ? { loopbackPort } : {}),
  };
}

async function validateAuthRequest(
  request: Request,
  token: string,
  access: DesktopRequestAccess,
): Promise<AuthStart | AuthCancel | Response> {
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
 * 5. body `{ authUrl, timeoutMs?, loopbackPort?, pkce?, reason? }`: `authUrl` parses and is
 *    `https:` with a loopback, fragment-less `redirect_uri`, `timeoutMs` (if present) is a positive
 *    finite number, and `loopbackPort` (if present) is a port the `redirect_uri` does not
 *    contradict, else 400 `{code:"invalid"}`;
 * 6. PKCE S256: `authUrl` carries one `code_challenge` (43 base64url characters) and one
 *    `code_challenge_method=S256`, else 400 `{code:"pkce_required"}` — unless `pkce` is
 *    `"not-applicable"` with a non-empty `reason` (any other `pkce`, or no reason: 400 `invalid`),
 *    and then the `authUrl` must carry a `state` (400 `invalid`); a repeated `state` is `invalid`.
 *
 * Then a single-session guard (409 `{code:"busy"}`), the loopback listener on `127.0.0.1` and
 * `::1` alike (a fixed `loopbackPort` either address of which is in use: 409
 * `{code:"port_in_use"}`), and a timeout (408 `{code:"timeout"}`). Only a callback that carries the
 * `authUrl`'s `state` (when it has one) completes the session; another one is answered 400 and the
 * listener keeps waiting. On success: 200 `{ url }`.
 *
 * A body of `{ cancel: true, session }` (behind the same checks 1–4) ends the open session
 * instead: the page's cancel, since the system browser reports no cancellation. A session started
 * with a `session` key is bound to that page, as a scheme session is: only a cancel naming the
 * key ends it, and so does its own start request going away (the page reloaded or navigated).
 * That session answers 499 `{code:"cancelled"}`, and the cancel request 200 `{ cancelled }`
 * (whether it ended one).
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
    // Bound to the starting page, as a scheme session is: a session started with a key ends only
    // on a cancel naming it, not on one from another window of the app.
    const open = openSessionKey === undefined || parsed.session === openSessionKey
      ? cancelOpen
      : undefined;
    open?.();
    return Response.json({ cancelled: open !== undefined });
  }
  const { authUrl: authParsed, redirectUri, timeoutMs } = parsed;

  // Single session.
  if (busy) return fail(409, "busy", "another desktop auth session is still open");
  busy = true;

  let servers: Deno.HttpServer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let onCallback: (url: string) => void = () => {};
    const bound = bindCallbackListener(
      redirectUri,
      parsed.loopbackPort,
      parsed.state,
      (url) => onCallback(url),
    );
    if (bound instanceof Response) return bound;
    servers = bound.servers;
    openSessionKey = parsed.session;
    const callbackUrl = await new Promise<string | null | typeof CANCELLED>((resolve) => {
      cancelOpen = () => resolve(CANCELLED);
      // The starting page going away (a reload, a navigation) drops its request: end its session.
      request.signal?.addEventListener("abort", () => resolve(CANCELLED), { once: true });
      onCallback = resolve;
      const rewrittenAuth = new URL(authParsed.href);
      rewrittenAuth.searchParams.set("redirect_uri", bound.redirect);

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
    openSessionKey = undefined;
    await shutdownAll(servers);
    busy = false;
  }
}

/** The page the browser tab shows when a request to the redirect path is not this session's. */
const MISMATCH_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  "<title>Not this sign-in</title></head><body><p>This sign-in link does not belong to the " +
  "open sign-in.</p></body></html>";

/** How many ephemeral ports are tried for one free on both loopback addresses. */
const EPHEMERAL_ATTEMPTS = 16;

/** A static, script-free HTML answer. */
function htmlPage(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'",
    },
  });
}

/**
 * Whether a callback to the redirect path is this session's: when the authorization URL carried a
 * `state`, the callback carries exactly that one (compared in constant time). Any other request is
 * answered and ignored, so a forged redirect cannot end the session.
 */
function carriesState(url: URL, state: string | null): boolean {
  if (state === null) return true;
  const got = url.searchParams.getAll("state");
  return got.length === 1 && timingSafeEqual(got[0], state);
}

/** Close every listener of a session (a failed shutdown is ignored). */
async function shutdownAll(servers: readonly Deno.HttpServer[]): Promise<void> {
  await Promise.all(servers.map((server) => server.shutdown().catch(() => {})));
}

/** One loopback listener on `hostname:port` (0: an ephemeral port the OS picks). */
function listenOn(hostname: string, port: number, handler: Deno.ServeHandler): Deno.HttpServer {
  return Deno.serve({
    hostname,
    port,
    // Silence the default "Listening on…" line; keep the port off any log.
    onListen: () => {},
    onError: () => new Response(null, { status: 500 }),
  }, handler);
}

/**
 * The `::1` half of a dual bind on `port`: the server; `"in-use"` when another listener holds
 * `[::1]:port`; `null` when the host has no IPv6 loopback (then the IPv4 listener alone is the
 * redirect's only loopback address, and nobody else can hold the other).
 */
function listenV6(port: number, handler: Deno.ServeHandler): Deno.HttpServer | "in-use" | null {
  try {
    return listenOn("::1", port, handler);
  } catch (err) {
    return err instanceof Deno.errors.AddrInUse ? "in-use" : null;
  }
}

/**
 * Bind `127.0.0.1` and `::1` on the same port (RFC 8252 §7.3: both IP versions), so no other local
 * process can hold the other loopback address and catch a redirect the browser sends there (a
 * `localhost` redirect may be tried on `::1` first). A fixed `port` either address of which is
 * taken is `"in-use"`; an ephemeral one (`0`) is re-picked until both halves are free. A host
 * without IPv6 gets the IPv4 listener alone.
 */
function dualBind(port: number, handler: Deno.ServeHandler): Deno.HttpServer[] | "in-use" {
  for (let attempt = 0; attempt < (port === 0 ? EPHEMERAL_ATTEMPTS : 1); attempt++) {
    // A taken fixed port throws AddrInUse here, which the caller maps to `port_in_use`.
    const v4 = listenOn("127.0.0.1", port, handler);
    const v6 = listenV6((v4.addr as Deno.NetAddr).port, handler);
    if (v6 === null) return [v4];
    if (v6 !== "in-use") return [v4, v6];
    void v4.shutdown().catch(() => {});
  }
  return "in-use";
}

/**
 * Bind the one-shot listener for the redirect and say which `redirect_uri` the browser is sent to.
 * Both loopback addresses are bound on one port ({@link dualBind}); a host without IPv6 binds
 * `127.0.0.1` alone.
 *
 * - Ephemeral (no `loopbackPort`): a port the OS picks that is free on both; the `redirect_uri`
 *   host is rewritten to the literal `127.0.0.1` (RFC 8252 §8.3) and its port to the listener's,
 *   its path and query kept.
 * - Fixed (`loopbackPort`): that port. The `redirect_uri` keeps its host as written, since a
 *   provider compares it with the registered one (a `localhost` registration such as
 *   `http://localhost:1455/…` stays usable: the dual bind holds every address `localhost` resolves
 *   to), and gains the port. Either address in use answers 409 `port_in_use`.
 *
 * Only a request to the redirect's path carrying the authorization URL's `state` (when it had one)
 * completes the session; another request to that path gets a 400 page and the session keeps
 * waiting, and anything else is a 404.
 */
function bindCallbackListener(
  redirectUri: URL,
  loopbackPort: number | undefined,
  state: string | null,
  onCallback: (url: string) => void,
): { servers: Deno.HttpServer[]; redirect: string } | Response {
  const redirectPath = redirectUri.pathname;
  const handler: Deno.ServeHandler = (req) => {
    const url = new URL(req.url);
    if (url.pathname !== redirectPath) return new Response("not found", { status: 404 });
    if (!carriesState(url, state)) return htmlPage(400, MISMATCH_HTML);
    // The code/state ride the query on a loopback redirect — capture the whole URL.
    onCallback(req.url);
    return htmlPage(200, SUCCESS_HTML);
  };
  let servers: Deno.HttpServer[] | "in-use";
  try {
    servers = dualBind(loopbackPort ?? 0, handler);
  } catch (err) {
    servers = err instanceof Deno.errors.AddrInUse ? "in-use" : [];
  }
  if (servers === "in-use") {
    return loopbackPort === undefined
      ? fail(500, "unsupported", "no loopback port was free on both 127.0.0.1 and ::1")
      : fail(409, "port_in_use", `loopback port ${loopbackPort} is in use`);
  }
  if (servers.length === 0) {
    return fail(500, "unsupported", "could not listen for the OAuth redirect");
  }
  const redirect = new URL(redirectUri.href);
  if (loopbackPort === undefined) redirect.hostname = "127.0.0.1";
  redirect.port = String((servers[0].addr as Deno.NetAddr).port);
  return { servers, redirect: redirect.href };
}

/** Forget the module's single-session flag (tests only). */
export function resetDesktopAuthSessionForTesting(): void {
  busy = false;
  cancelOpen = undefined;
  openSessionKey = undefined;
}
