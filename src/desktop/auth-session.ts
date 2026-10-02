/**
 * OAuth / OpenID Connect sign-in for Deno Desktop (`denext/desktop`): the BROWSER side of the
 * RFC 8252 loopback-redirect flow. It asks the desktop runtime (over a per-launch, token-gated
 * local endpoint) to open the system browser and run a one-shot `127.0.0.1` listener for the
 * redirect; the runtime resolves with the callback URL. This complements the mobile
 * {@link openAuthSession} (an `ASWebAuthenticationSession` / Custom Tab / web popup) — same
 * shapes, a different host.
 *
 * This module runs in the client bundle: web APIs only, no Deno APIs. The server half lives in
 * `./auth-session-runtime.ts`.
 *
 * Nothing runs at import.
 *
 * @module
 */

import type {
  AuthCancelOverlayText,
  AuthSessionError,
  AuthSessionErrorCode,
  AuthSessionOptions,
} from "../mobile/auth-session.ts";
import { desktopRpc, isDesktopBridgeError } from "./bridge-client.ts";
import { showAuthCancelOverlay } from "./auth-cancel-overlay.ts";

/** The error codes the runtime may send back as-is; anything else becomes `unsupported`. */
const AUTH_SESSION_CODES: ReadonlySet<string> = new Set<AuthSessionErrorCode>([
  "cancelled",
  "busy",
  "invalid",
  "unsupported",
  "timeout",
  "scheme_not_declared",
  "pkce_required",
  "scheme_owned_by_other_app",
  "scheme_not_registered",
  "session_in_progress",
]);

/** The path the desktop runtime serves the loopback auth-session endpoint at. */
const AUTH_SESSION_PATH = "/_denext/desktop/auth-session";

/**
 * The per-launch desktop globals the runtime injects into the served shell (see
 * `injectDesktopGlobal` in `src/build/desktop.ts`); `token` gates the local endpoint. Read
 * through a cast, not a `declare global`: JSR refuses a published module that changes the
 * global types.
 */
function desktopGlobals(): { desktop?: boolean; token?: string } | undefined {
  return (globalThis as { __denext?: { desktop?: boolean; token?: string } }).__denext;
}

// A local copy of the mobile module's error factory — intentionally NOT imported from
// mobile/auth-session.ts: that module dynamic-imports THIS one for the desktop dispatch, so
// importing back would form an initialization cycle. The shape is identical (verified by a test).
/** An {@linkcode AuthSessionError} — the identical shape the mobile module produces. */
function authSessionError(
  code: AuthSessionErrorCode,
  message: string,
  handler?: string,
): AuthSessionError {
  const err = new Error(`openAuthSession: ${message}`) as Error & {
    code: AuthSessionErrorCode;
    handler?: string;
  };
  err.name = "AuthSessionError";
  err.code = code;
  if (handler !== undefined) err.handler = handler;
  return err;
}

/**
 * Ask the Deno Desktop runtime to run a system-browser OAuth sign-in and hand back the callback
 * URL. Only works inside a `denext/desktop` window (it reads the per-launch token the runtime
 * injects); elsewhere it rejects `unsupported`.
 *
 * PKCE and `state` stay your job: build the authorization URL (with a `redirect_uri` whose host
 * the runtime rewrites to its ephemeral loopback port), pass it here, then verify `state` and
 * exchange the `code` from the returned URL. They are also what defeats a local-process race:
 * another process that discovered the random callback port could hit it with a forged redirect
 * before the real browser does, so a `state` you generated and re-check (and PKCE) are required.
 *
 * The system browser reports no cancellation, so while the session waits a cancel overlay (see
 * {@linkcode showAuthCancelOverlay}) offers the user a Cancel button, unless `cancelOverlay` is
 * `false`; aborting `signal` cancels too. Either ends the session with `cancelled`.
 *
 * @param url The provider's authorization URL (absolute `https:`, with a loopback `redirect_uri`).
 * @param opts `timeoutMs` — give up after this many ms (the runtime's default is 5 minutes);
 * `signal` — abort to cancel; `cancelOverlay` — `false` to hide the overlay, or its text.
 * @returns The full callback URL (`code`, `state` and all). Rejects with an
 * {@linkcode AuthSessionError} whose `code` is one of {@linkcode AuthSessionErrorCode}.
 */
export async function startDesktopAuthSession(
  url: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    cancelOverlay?: false | AuthCancelOverlayText;
  },
): Promise<{ url: string }> {
  const token = desktopGlobals()?.token;
  if (typeof token !== "string" || token === "") {
    throw authSessionError("unsupported", "not running under Deno Desktop");
  }
  const signal = opts?.signal;
  if (signal?.aborted) throw authSessionError("cancelled", "the sign-in was cancelled");
  const cancel = () =>
    void postAuthSession(token, { cancel: true }).then((r) => r.body?.cancel(), () => {});
  signal?.addEventListener("abort", cancel, { once: true });
  const hideOverlay = opts?.cancelOverlay === false
    ? () => {}
    : showAuthCancelOverlay(cancel, opts?.cancelOverlay || undefined);

  let res: Response;
  try {
    res = await postAuthSession(token, { authUrl: url, timeoutMs: opts?.timeoutMs });
  } catch {
    // Network failure — treat as unsupported (no runtime answered).
    throw authSessionError("unsupported", "the desktop auth-session request failed");
  } finally {
    hideOverlay();
    signal?.removeEventListener("abort", cancel);
  }
  return await authSessionResult(res);
}

/** POST `body` to the runtime's token-gated loopback auth-session endpoint. */
function postAuthSession(token: string, body: unknown): Promise<Response> {
  return fetch(AUTH_SESSION_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-denext-desktop-token": token,
    },
    body: JSON.stringify(body),
  });
}

/** The endpoint's answer as the callback URL, or the {@linkcode AuthSessionError} it carries. */
async function authSessionResult(res: Response): Promise<{ url: string }> {
  let body: { url?: unknown; code?: unknown; message?: unknown };
  try {
    body = await res.json();
  } catch {
    throw authSessionError("unsupported", "the desktop auth-session response was not JSON");
  }
  if (res.status !== 200) throw authSessionFailure(body);
  if (typeof body?.url !== "string") {
    throw authSessionError("unsupported", "the desktop auth session returned no callback URL");
  }
  return { url: body.url };
}

/** A non-200 envelope `{ code, message }` as an {@linkcode AuthSessionError}. */
function authSessionFailure(body: { code?: unknown; message?: unknown }): AuthSessionError {
  // The runtime answers `unavailable` when the app hasn't enabled the `auth-session` desktop
  // capability (`denext desktop add auth-session`); surface that as `unsupported` with the fix.
  if (body?.code === "unavailable") {
    return authSessionError(
      "unsupported",
      "the desktop auth-session capability is not enabled: run `denext desktop add auth-session`",
    );
  }
  const code = typeof body?.code === "string" && AUTH_SESSION_CODES.has(body.code)
    ? body.code as AuthSessionErrorCode
    : "unsupported";
  const message = typeof body?.message === "string"
    ? body.message
    : "the desktop auth session failed";
  return authSessionError(code, message);
}

/** Whether `uri` is an http(s) URL (a loopback redirect is the loopback flow's). */
function isHttpUrl(uri: string): boolean {
  try {
    const p = new URL(uri).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether an {@linkcode openAuthSession} call on desktop takes the custom-scheme flow rather than
 * the loopback one: a `callbackScheme` plus either a `callbackPrefix` or a `redirect_uri` that is
 * not http(s). A loopback `redirect_uri` (or none) keeps the loopback flow.
 *
 * @param url The authorization URL (already checked to be https).
 * @param options The call's options.
 * @returns `true` for the custom-scheme flow.
 */
export function usesSchemeCallback(url: string, options: AuthSessionOptions | undefined): boolean {
  if (typeof options?.callbackScheme !== "string") return false;
  if (options.callbackPrefix !== undefined) return true;
  const redirect = new URL(url).searchParams.get("redirect_uri");
  return redirect !== null && !isHttpUrl(redirect);
}

/** A bridge failure of the custom-scheme flow as an {@linkcode AuthSessionError}. */
function fromBridge(err: unknown): AuthSessionError {
  if (!isDesktopBridgeError(err)) {
    return authSessionError("unsupported", "the desktop auth session failed");
  }
  if (err.code === "unavailable") {
    return authSessionError(
      "unsupported",
      "custom-scheme callbacks need the auth-session capability (`denext desktop add " +
        "auth-session`) and denext's pinned Deno Desktop runtime",
    );
  }
  const code = err.code === "validation"
    ? "invalid"
    : AUTH_SESSION_CODES.has(err.code)
    ? err.code as AuthSessionErrorCode
    : "unsupported";
  const handler = (err.data as { handler?: unknown } | undefined)?.handler;
  // The bridge message is "desktop authSession.start: <code>: <message>"; keep the message.
  const message = err.message.replace(/^desktop authSession\.start: [^:]+: /, "");
  return authSessionError(code, message, typeof handler === "string" ? handler : undefined);
}

/**
 * Whether the runtime runs a custom-scheme sign-in in the OS's own auth session (macOS), whose
 * sheet has its own Cancel button. `false` on Windows and Linux, and on a runtime that cannot say.
 */
export async function hasOsAuthSession(): Promise<boolean> {
  try {
    const caps = await desktopRpc<{ osSession?: unknown } | null>(
      "authSession",
      "capabilities",
      {},
    );
    return caps?.osSession === true;
  } catch {
    return false;
  }
}

/**
 * What only denext's own callers (`denext/desktop/clerk`) add to a custom-scheme session; never
 * reachable from {@linkcode AuthSessionOptions}.
 */
export interface SchemeSessionInternals {
  /** Run only in the OS's auth session (the callback never travels as a deep link). */
  readonly osSessionOnly?: boolean;
  /** The Clerk transport's nonce binding, with the preload key that proves it. */
  readonly binding?: string;
  /** The per-launch preload key (see `injectDesktopGlobal`). */
  readonly bindingKey?: string;
}

/** The `authSession.start` arguments: only what was given, plus the page's session key. */
function schemeStartArgs(
  url: string,
  options: AuthSessionOptions,
  internal: SchemeSessionInternals,
  session: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { url, callbackScheme: options.callbackScheme };
  if (options.callbackPrefix !== undefined) args.callbackPrefix = options.callbackPrefix;
  if (options.pkce !== undefined) {
    Object.assign(args, { pkce: options.pkce, reason: options.reason });
  }
  if (options.state !== undefined) args.state = options.state;
  if (options.timeoutMs !== undefined) args.timeoutMs = options.timeoutMs;
  if (options.preferEphemeral === true) args.ephemeral = true;
  if (internal.osSessionOnly === true) args.osSessionOnly = true;
  if (internal.binding !== undefined) {
    Object.assign(args, { binding: internal.binding, bindingKey: internal.bindingKey ?? "" });
  }
  args.session = session;
  return args;
}

/**
 * The Deno Desktop custom-scheme sign-in, resolving with the callback URL once it matches (see
 * `src/desktop/scheme-auth-session.ts` for every check). On macOS it runs in the OS's auth session
 * (`ASWebAuthenticationSession`: a sheet on the app's window, a real `cancelled` when the user
 * closes it, private with `preferEphemeral`); on Windows and Linux the runtime opens the system
 * browser and the callback comes back as a deep link, and a cancel overlay (see
 * {@linkcode showAuthCancelOverlay}) offers the user a Cancel button unless `cancelOverlay` is
 * `false`. Aborting `options.signal` cancels the session (`cancelled`) everywhere.
 *
 * @param url The provider's authorization URL (absolute `https:`).
 * @param options `callbackScheme` (declared in `desktop.app.deepLinks`), and optionally
 * `callbackPrefix`, `pkce` + `reason`, `state`, `timeoutMs`, `signal`, `preferEphemeral`,
 * `cancelOverlay`.
 * @param internal What denext's own callers add (never from the page's options).
 * @returns The full callback URL. Rejects with an {@linkcode AuthSessionError}.
 */
export async function startDesktopSchemeAuthSession(
  url: string,
  options: AuthSessionOptions,
  internal: SchemeSessionInternals = {},
): Promise<{ url: string }> {
  const signal = options.signal;
  if (signal?.aborted) throw authSessionError("cancelled", "the sign-in was cancelled");
  // This page's key for the session: only a cancel naming it ends the session (not another window).
  const session = crypto.randomUUID();
  const onAbort = () => void desktopRpc("authSession", "cancel", { session }).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const osSession = options.cancelOverlay !== false && await hasOsAuthSession();
  if (signal?.aborted) {
    signal.removeEventListener("abort", onAbort);
    throw authSessionError("cancelled", "the sign-in was cancelled");
  }
  const hideOverlay = options.cancelOverlay === false || osSession
    ? () => {}
    : showAuthCancelOverlay(onAbort, options.cancelOverlay || undefined);
  let out: { url?: unknown } | null;
  try {
    out = await desktopRpc<{ url?: unknown } | null>(
      "authSession",
      "start",
      schemeStartArgs(url, options, internal, session),
      { timeoutMs: false },
    );
  } catch (err) {
    throw fromBridge(err);
  } finally {
    hideOverlay();
    signal?.removeEventListener("abort", onAbort);
  }
  if (typeof out?.url !== "string") {
    throw authSessionError("unsupported", "the desktop auth session returned no callback URL");
  }
  return { url: out.url };
}
