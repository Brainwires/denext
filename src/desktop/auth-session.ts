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
  AuthSessionError,
  AuthSessionErrorCode,
  AuthSessionOptions,
} from "../mobile/auth-session.ts";
import { desktopRpc, isDesktopBridgeError } from "./bridge-client.ts";

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
 * @param url The provider's authorization URL (absolute `https:`, with a loopback `redirect_uri`).
 * @param opts `timeoutMs` — give up after this many ms (the runtime's default is 5 minutes).
 * @returns The full callback URL (`code`, `state` and all). Rejects with an
 * {@linkcode AuthSessionError} whose `code` is one of {@linkcode AuthSessionErrorCode}.
 */
export async function startDesktopAuthSession(
  url: string,
  opts: { timeoutMs?: number },
): Promise<{ url: string }> {
  const token = desktopGlobals()?.token;
  if (typeof token !== "string" || token === "") {
    throw authSessionError("unsupported", "not running under Deno Desktop");
  }

  let res: Response;
  try {
    res = await fetch(AUTH_SESSION_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-denext-desktop-token": token,
      },
      body: JSON.stringify({ authUrl: url, timeoutMs: opts?.timeoutMs }),
    });
  } catch {
    // Network failure — treat as unsupported (no runtime answered).
    throw authSessionError("unsupported", "the desktop auth-session request failed");
  }

  let body: { url?: unknown; code?: unknown; message?: unknown };
  try {
    body = await res.json();
  } catch {
    throw authSessionError("unsupported", "the desktop auth-session response was not JSON");
  }

  if (res.status !== 200) {
    // The runtime answers `unavailable` when the app hasn't enabled the `auth-session` desktop
    // capability (`denext desktop add auth-session`); surface that as `unsupported` with the fix.
    if (body?.code === "unavailable") {
      throw authSessionError(
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
    throw authSessionError(code, message);
  }

  if (typeof body?.url !== "string") {
    throw authSessionError("unsupported", "the desktop auth session returned no callback URL");
  }
  return { url: body.url };
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
 * The Deno Desktop custom-scheme sign-in: the runtime opens the system browser and resolves with
 * the callback deep link once it matches (see `src/desktop/scheme-auth-session.ts` for every
 * check). Aborting `options.signal` cancels the session (`cancelled`).
 *
 * @param url The provider's authorization URL (absolute `https:`).
 * @param options `callbackScheme` (declared in `desktop.app.deepLinks`), and optionally
 * `callbackPrefix`, `pkce` + `reason`, `state`, `timeoutMs`, `signal`.
 * @returns The full callback URL. Rejects with an {@linkcode AuthSessionError}.
 */
export async function startDesktopSchemeAuthSession(
  url: string,
  options: AuthSessionOptions,
): Promise<{ url: string }> {
  const signal = options.signal;
  if (signal?.aborted) throw authSessionError("cancelled", "the sign-in was cancelled");
  const onAbort = () => void desktopRpc("authSession", "cancel", {}).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  let out: { url?: unknown } | null;
  try {
    out = await desktopRpc<{ url?: unknown } | null>("authSession", "start", {
      url,
      callbackScheme: options.callbackScheme,
      ...(options.callbackPrefix !== undefined ? { callbackPrefix: options.callbackPrefix } : {}),
      ...(options.pkce !== undefined ? { pkce: options.pkce, reason: options.reason } : {}),
      ...(options.state !== undefined ? { state: options.state } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }, { timeoutMs: false });
  } catch (err) {
    throw fromBridge(err);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (typeof out?.url !== "string") {
    throw authSessionError("unsupported", "the desktop auth session returned no callback URL");
  }
  return { url: out.url };
}
