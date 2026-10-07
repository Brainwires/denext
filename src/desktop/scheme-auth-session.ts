/**
 * Deno Desktop OAuth sign-in with a CUSTOM-SCHEME callback (`myapp://auth/callback`), runtime side.
 * Where the OS has an auth session of its own (macOS: `ASWebAuthenticationSession`, through
 * `Deno.desktop.authSession` of denext's pinned runtime 2.9.7-denext.6 and later) the sign-in runs
 * in it: a sheet on the app's window that ends at the callback scheme, reports a real `cancelled`
 * when the user closes it, and can be `ephemeral` (no cookies shared with the browser). Elsewhere
 * (Windows and Linux answer `not_supported`, and older runtimes have no `authSession`) it opens the
 * system browser at the authorization URL, then waits for the callback to come back as a deep link
 * ({@link ./launch-events.ts}). The loopback-redirect flow
 * ({@link ./auth-session-runtime.ts}) stays the default; this one exists for providers whose
 * redirect allowlist holds the app's scheme (Clerk's native flow, most mobile-style OAuth apps).
 *
 * AUTH-CRITICAL. A custom scheme is not owned by anyone: any program of the same user can register
 * itself for it and receive the callback (RFC 8252 §8.6). The defences, in order, all failing
 * closed:
 *
 * 1. The scheme must be declared in `desktop.app.deepLinks` (`scheme_not_declared`).
 * 2. PKCE S256 is mandatory: the URL carries exactly one `code_challenge` (43 base64url
 *    characters, a SHA-256) and one `code_challenge_method=S256` (`pkce_required`), so an
 *    intercepted `code` is useless without the verifier the app kept. The only exception is an
 *    explicit `pkce: "not-applicable"` with a `reason`, for a provider that binds the callback to
 *    the initiating client some other way — and then a `state` is mandatory too, unless the session
 *    may only run in the OS's auth session (`osSessionOnly`, whose callback never travels as a deep
 *    link) or it is `denext/desktop/clerk`'s transport, proven by the per-launch preload key
 *    (`binding: "clerk-client-nonce"`; see that module). That binding also needs a per-session
 *    callback nonce (rule 4b): the transport puts it in the redirect URL it gives Clerk, so only a
 *    callback that went through THIS sign-in carries it.
 * 3. The callback must match the expected target EXACTLY: scheme, host and path of the URL's own
 *    `redirect_uri` when that is a `<scheme>:` URL, else of the `callbackPrefix` the caller gives.
 * 4. `state` round-trips: when the target is the URL's `redirect_uri`, the URL's `state` (if any)
 *    must come back byte for byte; with a `callbackPrefix` (the URL's redirect goes to another hop)
 *    the caller's `state` option (if any). A callback for the target with a missing or different
 *    `state` is swallowed — it neither resolves the session nor reaches the page's routes — and the
 *    session keeps waiting.
 * 4b. A callback nonce (`nonce`, at least 128 bits of base64url, generated per session by the
 *    caller that also wrote it into the redirect URL) must come back exactly once as the
 *    `denext_nonce` query parameter, compared in constant time. It is mandatory with the Clerk
 *    binding, whose callback has no `state`: a forged deep link (any same-user program can open
 *    `<scheme>://…?rotating_token_nonce=…`) cannot complete the session without it, whether or not
 *    Clerk binds its `rotating_token_nonce` to the initiating client. A callback without it, with
 *    another one, or replayed after the session settled is swallowed like a bad `state`.
 * 5. Who handles the scheme is checked before the system browser opens
 *    (`Deno.desktop.getSchemeOwner`): `none` → register (never forced) and re-check; `other` →
 *    refuse with `scheme_owned_by_other_app` (+ the handler, for display) so the caller falls back
 *    to the loopback flow or asks the user, who may then call `claimDeepLinkScheme`. This is
 *    advisory — any same-user program may re-register at any time — which is why 2–4 are the real
 *    defence. It guards a callback that travels as a deep link, so the OS's auth session skips it:
 *    the sheet catches its own callback scheme whoever handles that scheme's links (a sheet that
 *    answers `not_supported` runs the check before falling back to the browser).
 * 6. One session at a time (`session_in_progress`), a timeout (10 minutes by default), and
 *    `cancel` (the page's `AbortSignal`; the system browser on Windows and Linux reports no
 *    cancellation, so the page's cancel and the timeout are the only ends there). A session is
 *    bound to the page that started it: `cancel` must name the session's own key (`session`, a
 *    random value the starting page keeps), and the session ends when the starting page's `start`
 *    request goes away (a reload or navigation of THAT page) — a navigation in another window does
 *    not touch it.
 *
 * The OS session runs after the same checks (1–4), and its callback URL is held to rule 3 and 4
 * too: a sheet that ends anywhere else, or with another `state`, rejects `invalid` (it cannot keep
 * waiting: the OS session is over). While the sheet is up, only the sheet can complete the
 * session: a matching link the OS delivers as a deep link meanwhile is swallowed, never resolving.
 * A page cancel, the timeout or the starting page going away settles the page's promise and closes
 * the sheet through `Deno.desktop.authSession.cancel()` (runtime 2.9.7-denext.7 and later,
 * feature-detected). A runtime without it leaves the sheet up until the user closes it; until then
 * a new session gets `session_in_progress`.
 *
 * The callback URL is consumed here BEFORE the deep-link routing, so it never reaches `onDeepLink`
 * or the page's router. Nothing here logs a URL (they carry codes and states).
 *
 * Runtime-only (imported by `runDesktop`, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, DesktopCapError } from "./extension.ts";
import type { DesktopAppApi, DesktopAuthSessionApi } from "./launch-events.ts";

/** The default session timeout: 10 minutes. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** The longest timeout a caller may ask for: 1 hour. */
const MAX_TIMEOUT_MS = 60 * 60_000;
/** The longest `reason` kept for a `pkce: "not-applicable"` session. */
const MAX_REASON_CHARS = 500;
/** The `binding` only `denext/desktop/clerk`'s transport may claim (with the preload key). */
const CLERK_NONCE_BINDING = "clerk-client-nonce";
/** The query parameter Clerk's native OAuth callback carries (the client-bound sign-in nonce). */
const CLERK_NONCE_PARAM = "rotating_token_nonce";
/** The query parameter that carries the per-session callback nonce (rule 4b). */
const CALLBACK_NONCE_PARAM = "denext_nonce";
/** A callback nonce: base64url, at least 22 characters (≥ 128 bits). */
const CALLBACK_NONCE = /^[A-Za-z0-9_-]{22,128}$/;
/** A PKCE S256 `code_challenge`: base64url(SHA-256), 43 characters, no padding. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** A session key: what the starting page keeps to cancel its own session. */
const SESSION_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** Where a callback must land: scheme, host and path (compared exactly). */
interface Target {
  readonly protocol: string;
  readonly host: string;
  readonly path: string;
}

/** The validated arguments of a `start` call. */
interface StartRequest {
  readonly url: string;
  readonly scheme: string;
  readonly target: Target;
  /** The `state` the callback must carry, or `null` when none is expected. */
  readonly state: string | null;
  /** The callback nonce the callback must carry (rule 4b), or `null` when none is expected. */
  readonly nonce: string | null;
  readonly timeoutMs: number;
  /** A private OS auth session (macOS); ignored by the system browser. */
  readonly ephemeral: boolean;
  /** Run only in the OS's auth session; refuse (`unsupported`) where there is none. */
  readonly osSessionOnly: boolean;
  /** The starting page's key for this session (its `cancel` must name it). */
  readonly key: string;
}

/** The open session. */
interface Pending {
  readonly target: Target;
  readonly state: string | null;
  /** The per-session callback nonce (rule 4b), or `null`. */
  readonly nonce: string | null;
  readonly resolve: (url: string) => void;
  readonly reject: (err: DesktopCapError) => void;
  /** Set while the OS's auth session (the sheet) owns the session: deep links never resolve it. */
  viaOs: boolean;
  /** The OS session whose sheet is up for this session (closed when the session ends early). */
  os?: DesktopAuthSessionApi;
}

/** Options for {@linkcode createSchemeAuthSessions}. */
export interface SchemeAuthOptions {
  /** The declared deep-link schemes (`desktop.app.deepLinks`), lower-case. */
  readonly schemes: readonly string[];
  /** The runtime's app API (`Deno.desktop`), for the scheme owner check. */
  readonly api?: DesktopAppApi;
  /** Open the system browser (default: the loopback flow's argv-only opener). */
  readonly openBrowser: (url: string) => Promise<void> | void;
  /**
   * The per-launch key injected only into `desktop.preload` (gone before the page's own scripts
   * run): the proof a `binding: "clerk-client-nonce"` session comes from `denext/desktop/clerk`
   * installed there. Without one, that binding is always refused.
   */
  readonly preloadKey?: string;
}

/** What {@linkcode createSchemeAuthSessions} returns. */
export interface SchemeAuthSessions {
  /** The `authSession` bridge capability: `start` and `cancel`. */
  readonly capability: DesktopCapability;
  /**
   * Offer an incoming deep link: `true` when it belongs to the open session (it resolved it, or it
   * was a callback for the session's target with a bad `state` and was swallowed), so it must not
   * be routed to the page.
   */
  claim(url: string): boolean;
}

/** An `invalid` (400) error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("invalid", message);
}

/** The scheme / host / path of `url` (an empty path reads `/`), or `undefined` when unparseable. */
function targetOf(url: string): Target | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  return {
    protocol: u.protocol.toLowerCase(),
    host: u.host.toLowerCase(),
    path: u.pathname === "" ? "/" : u.pathname,
  };
}

/** Whether `a` and `b` are the same callback target. */
function sameTarget(a: Target, b: Target): boolean {
  return a.protocol === b.protocol && a.host === b.host && a.path === b.path;
}

/** A string field of the args, or `undefined`; a present non-string is `invalid`. */
function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(`${key} must be a string`);
  return v;
}

/** The declared callback scheme, normalized, or `scheme_not_declared`. */
function checkScheme(schemes: readonly string[], raw: unknown): string {
  const scheme = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || !schemes.includes(scheme)) {
    throw new DesktopCapError(
      "scheme_not_declared",
      `the callback scheme "${String(raw)}" is not declared in desktop.app.deepLinks`,
    );
  }
  return scheme;
}

/** The authorization URL: absolute `https:`. */
function checkAuthUrl(raw: unknown): URL {
  let url: URL | undefined;
  try {
    url = typeof raw === "string" ? new URL(raw) : undefined;
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:" || url.hostname === "") {
    throw invalid("url must be an absolute https: URL");
  }
  return url;
}

/**
 * The callback target and whether it is the URL's own `redirect_uri` (rule 3 in the module docs).
 * A `redirect_uri` with the callback scheme wins; a `callbackPrefix` that disagrees with it is
 * `invalid`; with neither there is no target (`invalid`).
 */
function resolveTarget(
  url: URL,
  scheme: string,
  callbackPrefix: string | undefined,
): { target: Target; fromRedirect: boolean } {
  const redirect = url.searchParams.get("redirect_uri");
  const fromRedirect = redirect !== null ? targetOf(redirect) : undefined;
  const prefix = callbackPrefix !== undefined ? targetOf(callbackPrefix) : undefined;
  if (callbackPrefix !== undefined && prefix?.protocol !== `${scheme}:`) {
    throw invalid(`callbackPrefix must be a ${scheme}: URL`);
  }
  if (fromRedirect?.protocol === `${scheme}:`) {
    if (prefix && !sameTarget(prefix, fromRedirect)) {
      throw invalid("callbackPrefix does not match the URL's redirect_uri");
    }
    return { target: fromRedirect, fromRedirect: true };
  }
  if (prefix) return { target: prefix, fromRedirect: false };
  throw invalid(
    `no callback target: the URL's redirect_uri is not a ${scheme}: URL and no callbackPrefix was given`,
  );
}

/** The single value of a query parameter: `null` when absent; a repeated one is `invalid`. */
function single(url: URL, name: string): string | null {
  const all = url.searchParams.getAll(name);
  if (all.length > 1) throw invalid(`the URL carries ${name} more than once`);
  return all[0] ?? null;
}

/**
 * Rule 2: PKCE S256 in the URL (each parameter once, the challenge a SHA-256's base64url), unless
 * explicitly not applicable with a reason. Returns whether it was waived.
 */
function checkPkce(url: URL, args: Record<string, unknown>): boolean {
  const pkce = optString(args, "pkce");
  if (pkce !== undefined && pkce !== "not-applicable") {
    throw invalid('pkce must be "not-applicable" when given');
  }
  if (pkce === "not-applicable") {
    const reason = optString(args, "reason")?.trim() ?? "";
    if (reason === "" || reason.length > MAX_REASON_CHARS) {
      throw invalid('pkce: "not-applicable" needs a reason (why the provider binds the callback)');
    }
    return true;
  }
  const challenge = single(url, "code_challenge") ?? "";
  if (!S256_CHALLENGE.test(challenge) || single(url, "code_challenge_method") !== "S256") {
    throw new DesktopCapError(
      "pkce_required",
      "a custom-scheme callback needs PKCE: the URL must carry one code_challenge (a 43-character " +
        "base64url SHA-256) and code_challenge_method=S256",
    );
  }
  return false;
}

/**
 * Rule 4's expected `state`: the URL's own (once) when the target is its `redirect_uri`, AND the
 * caller's option — they must agree when both are given, and either alone is kept; with a
 * `callbackPrefix` target only the caller's (the URL's belongs to another hop).
 */
function expectedState(url: URL, args: Record<string, unknown>, fromRedirect: boolean) {
  const caller = optString(args, "state") ?? null;
  if (!fromRedirect) return caller;
  const own = single(url, "state");
  if (own !== null && caller !== null && own !== caller) {
    throw invalid("state does not match the URL's state");
  }
  return own ?? caller;
}

/** `true` only for a boolean `true`; absent → `false`; anything else is `invalid`. */
function optFlag(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw invalid(`${key} must be a boolean`);
  return v;
}

/** The starting page's session key (required: its `cancel` must name it). */
function checkKey(raw: unknown): string {
  if (typeof raw !== "string" || !SESSION_KEY.test(raw)) {
    throw invalid("session must be a random key of 16–128 base64url characters");
  }
  return raw;
}

/** Constant-time string equality (the preload key). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Whether the session claims the Clerk binding, proven by the preload key. A `binding` without a
 * valid key is `invalid` (a page cannot claim it).
 */
function checkBinding(args: Record<string, unknown>, preloadKey: string | undefined): boolean {
  const binding = optString(args, "binding");
  if (binding === undefined) return false;
  const key = optString(args, "bindingKey") ?? "";
  if (binding !== CLERK_NONCE_BINDING || !preloadKey || !sameSecret(key, preloadKey)) {
    throw invalid("binding is reserved for denext/desktop/clerk installed from desktop.preload");
  }
  return true;
}

/**
 * Rule 4b: the per-session callback nonce (≥ 128 bits of base64url), mandatory with the Clerk
 * binding; `null` when none is given (and none is required).
 */
function checkNonce(args: Record<string, unknown>, required: boolean): string | null {
  const nonce = optString(args, "nonce");
  if (nonce === undefined) {
    if (required) throw invalid("the Clerk binding needs a per-session callback nonce");
    return null;
  }
  if (!CALLBACK_NONCE.test(nonce)) {
    throw invalid("nonce must be 22–128 base64url characters (at least 128 bits)");
  }
  return nonce;
}

/** `ephemeral`: absent → `false`; else a boolean. */
function checkEphemeral(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") throw invalid("ephemeral must be a boolean");
  return raw;
}

/** The timeout: absent → the default; else a positive finite number of ms up to an hour. */
function checkTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_TIMEOUT_MS) {
    throw invalid(`timeoutMs must be a positive number of ms up to ${MAX_TIMEOUT_MS}`);
  }
  return raw;
}

/**
 * Validate a `start` call (rules 1–4 of the module docs), failing closed.
 *
 * @param schemes The declared schemes.
 * @param raw The call's arguments.
 * @param preloadKey The per-launch preload key ({@linkcode SchemeAuthOptions.preloadKey}).
 * @returns The validated request.
 */
export function parseSchemeAuthStart(
  schemes: readonly string[],
  raw: unknown,
  preloadKey?: string,
): StartRequest {
  if (typeof raw !== "object" || raw === null) throw invalid("arguments must be an object");
  const args = raw as Record<string, unknown>;
  const scheme = checkScheme(schemes, args.callbackScheme);
  const url = checkAuthUrl(args.url);
  const { target, fromRedirect } = resolveTarget(url, scheme, optString(args, "callbackPrefix"));
  const waived = checkPkce(url, args);
  const state = expectedState(url, args, fromRedirect);
  const osSessionOnly = optFlag(args, "osSessionOnly");
  const bound = checkBinding(args, preloadKey);
  const nonce = checkNonce(args, bound);
  // A waived-PKCE session without `state`: only OS-only, or the Clerk transport (with its nonce).
  if (waived && state === null && !osSessionOnly && !bound) {
    throw invalid(
      'pkce: "not-applicable" needs a state the callback must carry (or osSessionOnly)',
    );
  }
  return {
    url: url.href,
    scheme,
    target,
    state,
    nonce,
    timeoutMs: checkTimeout(args.timeoutMs),
    ephemeral: checkEphemeral(args.ephemeral),
    osSessionOnly,
    key: checkKey(args.session),
  };
}

/**
 * Rule 5: make sure this app handles `scheme` before a callback is sent to it. `none` → register
 * (never forced) and re-check; `other` → `scheme_owned_by_other_app`; still not ours →
 * `scheme_not_registered`. A runtime without owner detection fails closed (`unsupported`).
 */
async function ensureSchemeOwner(api: DesktopAppApi | undefined, scheme: string): Promise<void> {
  const getOwner = api?.getSchemeOwner;
  if (typeof getOwner !== "function") {
    throw new DesktopCapError(
      "unsupported",
      "this Deno Desktop runtime cannot tell which app handles the callback scheme " +
        "(Deno.desktop.getSchemeOwner): use the loopback flow, or denext's pinned runtime",
      { status: 501 },
    );
  }
  let info = await getOwner.call(api, scheme);
  if (info.owner === "none" && typeof api?.registerScheme === "function") {
    await api.registerScheme(scheme);
    info = await getOwner.call(api, scheme);
  }
  if (info.owner === "other") {
    throw new DesktopCapError(
      "scheme_owned_by_other_app",
      `another app handles ${scheme}: links, so the callback would go to it`,
      { status: 409, data: info.handler ? { handler: info.handler } : {} },
    );
  }
  if (info.owner !== "self") {
    throw new DesktopCapError(
      "scheme_not_registered",
      `this app could not register itself for ${scheme}: links (an unpackaged dev run?)`,
      { status: 409 },
    );
  }
}

/** Where an incoming callback URL stands against the open session (rules 3, 4 and 4b). */
function matchCallback(open: Pending, url: string): "match" | "bad_state" | "other" {
  const got = targetOf(url);
  if (!got || !sameTarget(got, open.target)) return "other";
  const params = new URL(url).searchParams;
  const states = params.getAll("state");
  if (open.state !== null && (states.length !== 1 || states[0] !== open.state)) {
    return "bad_state";
  }
  if (open.nonce !== null) {
    const nonces = params.getAll(CALLBACK_NONCE_PARAM);
    if (nonces.length !== 1 || !sameSecret(nonces[0], open.nonce)) return "bad_state";
  }
  return "match";
}

/**
 * Whether `url` carries a Clerk sign-in nonce or a callback nonce: never routed to the page
 * outside its session (a forgery or a replay).
 */
function hasClerkNonce(url: string): boolean {
  try {
    const params = new URL(url).searchParams;
    return params.has(CLERK_NONCE_PARAM) || params.has(CALLBACK_NONCE_PARAM);
  } catch {
    return false;
  }
}

/** The OS auth session when this runtime has one and it is supported here, else `undefined`. */
async function osAuthSession(
  api: DesktopAppApi | undefined,
): Promise<DesktopAuthSessionApi | undefined> {
  const session = api?.authSession;
  if (typeof session?.start !== "function" || typeof session.capabilities !== "function") {
    return undefined;
  }
  try {
    return (await session.capabilities())?.supported === true ? session : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Close the OS session's sheet the app gave up on (`Deno.desktop.authSession.cancel()`, runtime
 * 2.9.7-denext.7 and later): its `start` then rejects `cancelled`, which the caller has already
 * settled past. Feature-detected; a runtime without it (or one that throws) leaves the sheet up
 * until the user closes it.
 */
function closeOsSheet(os: DesktopAuthSessionApi): void {
  if (typeof os.cancel !== "function") return;
  try {
    os.cancel();
  } catch {
    // Best effort: the session is already settled for the page.
  }
}

/** An OS auth-session rejection (`AuthSessionError.code`) as the bridge's code, message, status. */
function osSessionError(err: unknown): [code: string, message: string, status: number] {
  switch ((err as { code?: unknown } | null)?.code) {
    case "cancelled":
      return ["cancelled", "the sign-in was cancelled", 499];
    case "busy":
      return ["session_in_progress", "another OS sign-in session is still open", 409];
    case "invalid":
      return ["invalid", "the OS sign-in session refused the URL or callback scheme", 400];
    default:
      return ["unsupported", "the OS sign-in session failed", 500];
  }
}

/**
 * Create the custom-scheme auth sessions: the `authSession` bridge capability and the claim hook
 * the launch router offers every incoming deep link to first.
 *
 * @param options The declared schemes, the runtime's app API and the browser opener.
 * @returns The sessions.
 */
export function createSchemeAuthSessions(options: SchemeAuthOptions): SchemeAuthSessions {
  const schemes = options.schemes.map((s) => s.toLowerCase());
  let busy = false;
  let pending: Pending | undefined;
  /** The open session's key (from `start`), which `cancel` must name. */
  let currentKey: string | undefined;
  /** A cancel that arrived while the session was still starting (the owner check). */
  let cancelEarly = false;

  /** End `open` with an error, if it is still the open session. */
  const endIf = (open: Pending, code: string, message: string, status: number): void => {
    if (pending !== open) return;
    pending = undefined;
    open.reject(new DesktopCapError(code, message, { status }));
  };

  /** Rule 5 for a session already open (the browser fallback): `false` when it ended `open`. */
  const ownerOk = async (open: Pending, scheme: string): Promise<boolean> => {
    try {
      await ensureSchemeOwner(options.api, scheme);
      return true;
    } catch (err) {
      if (pending === open) {
        pending = undefined;
        open.reject(
          err instanceof DesktopCapError
            ? err
            : new DesktopCapError("unsupported", "the scheme owner check failed", { status: 500 }),
        );
      }
      return false;
    }
  };

  /** End the open session early (page cancel, timeout, its page gone), closing its sheet if up. */
  const cancelPending = (code: string, message: string, status: number): boolean => {
    const open = pending;
    if (!open) {
      if (busy) cancelEarly = true;
      return busy;
    }
    endIf(open, code, message, status);
    if (open.os) closeOsSheet(open.os);
    open.os = undefined;
    return true;
  };

  /** The OS session's outcome for `open`: its callback, or why it ended. */
  const runOsSession = async (
    os: DesktopAuthSessionApi,
    req: StartRequest,
    open: Pending,
  ): Promise<void> => {
    let url: string;
    open.viaOs = true;
    open.os = os;
    try {
      ({ url } = await os.start({
        url: req.url,
        callbackScheme: req.scheme,
        ...(req.ephemeral ? { ephemeral: true } : {}),
      }));
    } catch (err) {
      open.viaOs = false;
      open.os = undefined;
      if ((err as { code?: unknown } | null)?.code === "not_supported" && pending === open) {
        if (req.osSessionOnly) {
          endIf(open, "unsupported", "this sign-in needs the OS's auth session", 501);
          return;
        }
        // No OS session after all: the system browser, whose callback is a deep link (rule 5).
        if (await ownerOk(open, req.scheme) && pending === open) await options.openBrowser(req.url);
        return;
      }
      endIf(open, ...osSessionError(err));
      return;
    }
    open.os = undefined;
    if (pending !== open) return; // cancelled or timed out while the sheet was up
    if (typeof url !== "string" || matchCallback(open, url) !== "match") {
      endIf(
        open,
        "invalid",
        "the OS sign-in session ended at a callback that does not match the redirect or state",
        400,
      );
      return;
    }
    pending = undefined;
    open.resolve(url);
  };

  /** Hand the sign-in to the OS session where there is one, else to the system browser. */
  const launch = async (req: StartRequest, open: Pending): Promise<void> => {
    const os = await osAuthSession(options.api);
    if (pending !== open) return;
    if (os) await runOsSession(os, req, open);
    else if (req.osSessionOnly) {
      endIf(open, "unsupported", "this sign-in needs the OS's auth session", 501);
    } else await options.openBrowser(req.url);
  };

  const run = (req: StartRequest): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (cancelEarly) {
        reject(new DesktopCapError("cancelled", "the sign-in was cancelled", { status: 499 }));
        return;
      }
      const timer = setTimeout(
        () => cancelPending("timeout", "no callback within the timeout", 408),
        req.timeoutMs,
      );
      const settle = () => clearTimeout(timer);
      const open: Pending = {
        target: req.target,
        state: req.state,
        nonce: req.nonce,
        resolve: (url) => (settle(), resolve(url)),
        reject: (err) => (settle(), reject(err)),
        viaOs: false,
      };
      pending = open;
      // Fire-and-forget like the loopback flow, but a failed launch ends the session.
      Promise.resolve().then(() => launch(req, open)).catch(() =>
        endIf(open, "unsupported", "the system browser could not be opened", 500)
      );
    });

  const start = async (args: unknown, ctx: { signal?: AbortSignal }): Promise<{ url: string }> => {
    const req = parseSchemeAuthStart(schemes, args, options.preloadKey);
    if (busy) {
      throw new DesktopCapError(
        "session_in_progress",
        "another desktop auth session is still open",
        { status: 409 },
      );
    }
    busy = true;
    cancelEarly = false;
    currentKey = req.key;
    // The starting page's request is the session's lifeline: when that page reloads or navigates
    // away, its `start` request is aborted and the session ends (no other window can end it).
    const gone = () => void cancelPending("cancelled", "the page that started it is gone", 499);
    ctx.signal?.addEventListener("abort", gone, { once: true });
    try {
      if (ctx.signal?.aborted) cancelEarly = true;
      // Rule 5 guards a callback that travels as a deep link; the OS's sheet catches its own.
      if (!(await osAuthSession(options.api))) await ensureSchemeOwner(options.api, req.scheme);
      return { url: await run(req) };
    } finally {
      ctx.signal?.removeEventListener("abort", gone);
      busy = false;
      cancelEarly = false;
      currentKey = undefined;
      pending = undefined;
    }
  };

  /** `cancel`: only the starting page's own key ends the session. */
  const cancel = (args: unknown): { cancelled: boolean } => {
    const key = (args as { session?: unknown } | null)?.session;
    if (currentKey === undefined || typeof key !== "string" || !sameSecret(key, currentKey)) {
      return { cancelled: false };
    }
    return { cancelled: cancelPending("cancelled", "the sign-in was cancelled", 499) };
  };

  /** What the page needs to know before it starts: whether the OS gives a sheet with a cancel. */
  const capabilities = async (): Promise<{ osSession: boolean; ephemeral: boolean }> => {
    const os = await osAuthSession(options.api);
    let ephemeral = false;
    try {
      ephemeral = os !== undefined && (await os.capabilities())?.ephemeral === true;
    } catch {
      ephemeral = false;
    }
    return { osSession: os !== undefined, ephemeral };
  };

  return {
    capability: {
      name: "authSession",
      methods: {
        // The session runs as long as its own timeout (≤ 1 h); the bridge deadline is off.
        start: { timeoutMs: false, handler: start },
        cancel: { handler: cancel },
        capabilities: { handler: capabilities },
      },
      // No onPageLoad: a navigation can come from ANY window. The session ends with its own
      // page's `start` request instead (see `start`).
    },
    claim: (url) => {
      const open = pending;
      // A Clerk nonce link outside its session (none open, another target) is a forgery or a
      // replay: dropped, never routed to the page.
      if (!open) return hasClerkNonce(url);
      const match = matchCallback(open, url);
      if (match === "other") return hasClerkNonce(url);
      if (match === "bad_state") return true; // a forged / stale callback: swallowed, keep waiting
      // The OS's sheet owns the session: only it can complete it (rule 6, OS session).
      if (open.viaOs) return true;
      pending = undefined;
      open.resolve(url);
      return true;
    },
  };
}
