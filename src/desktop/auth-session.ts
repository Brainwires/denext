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

import type { AuthSessionError, AuthSessionErrorCode } from "../mobile/auth-session.ts";

/** The path the desktop runtime serves the loopback auth-session endpoint at. */
const AUTH_SESSION_PATH = "/_denext/desktop/auth-session";

declare global {
  // The per-launch desktop globals the runtime injects into the served shell (see
  // `injectDesktopGlobal` in `src/build/desktop.ts`). `token` gates the local endpoint.
  var __denext: { desktop?: boolean; token?: string } | undefined;
}

// A local copy of the mobile module's error factory — intentionally NOT imported from
// mobile/auth-session.ts: that module dynamic-imports THIS one for the desktop dispatch, so
// importing back would form an initialization cycle. The shape is identical (verified by a test).
/** An {@linkcode AuthSessionError} — the identical shape the mobile module produces. */
function authSessionError(code: AuthSessionErrorCode, message: string): AuthSessionError {
  const err = new Error(`openAuthSession: ${message}`) as Error & { code: AuthSessionErrorCode };
  err.name = "AuthSessionError";
  err.code = code;
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
  const token = globalThis.__denext?.token;
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
    const code = typeof body?.code === "string" ? body.code as AuthSessionErrorCode : "unsupported";
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
