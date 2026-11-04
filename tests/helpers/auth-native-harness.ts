// A harness for denext auth's own endpoints driven through the real dispatcher
// (`handleAuthRequest`) inside a request context: a recording mailer and SMS sender, an event
// log, and the session cookie carried from one call to the next.

import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../../src/server/request-context.ts";
import { setRemoteAddr } from "../../src/server/remote-addr.ts";
import type { GoTrueSmsMessage } from "../../packages/auth/src/gotrue/options.ts";
import type { AuthAdapter } from "../../packages/auth/src/adapter.ts";
import { inMemoryAuthAdapter } from "../../packages/auth/src/memory-adapter.ts";
import { handleAuthRequest } from "../../packages/auth/src/routes.ts";
import { readAuthSession } from "../../packages/auth/src/session.ts";
import type {
  AuthConfig,
  AuthSession,
  VerificationRequestParams,
} from "../../packages/auth/src/types.ts";

export const ORIGIN = "https://app.test";
export const SECRET = "test-secret-value-at-least-32-chars-long";
const PAGES = {
  signIn: "/login",
  afterSignIn: "/home",
  mfa: "/mfa",
  verifyRequest: "/check",
  error: "/oops",
};
const SESSION_COOKIE = "__Host-denext_auth=";

/** One app, its recordings, and the cookie the last call left. */
export interface NativeHarness {
  config: AuthConfig;
  adapter: AuthAdapter;
  /** Every SMS handed to `sendSms`. */
  sms: GoTrueSmsMessage[];
  /** Every message handed to `sendVerificationRequest`. */
  mail: VerificationRequestParams[];
  /** Event names (`signInFailed:<reason>`) in firing order. */
  events: string[];
}

/**
 * Build an app with recording senders and events; `extra` is merged over the defaults.
 *
 * @param extra Config overrides (providers, captcha, hooks, …).
 * @param base The adapter (default: a fresh in-memory one).
 * @returns The harness.
 */
export function nativeHarness(
  extra: Partial<AuthConfig>,
  base: AuthAdapter = inMemoryAuthAdapter(),
): NativeHarness {
  const sms: GoTrueSmsMessage[] = [];
  const mail: VerificationRequestParams[] = [];
  const events: string[] = [];
  const log = (name: string) => () => void events.push(name);
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [],
    adapter: base,
    pages: PAGES,
    sendSms: (message) => void sms.push(message),
    sendVerificationRequest: (params) => void mail.push(params),
    events: {
      createUser: log("createUser"),
      emailVerified: log("emailVerified"),
      phoneVerified: log("phoneVerified"),
      userConverted: log("userConverted"),
      signIn: log("signIn"),
      sessionRevoked: log("sessionRevoked"),
      apiTokenRevoked: ({ reason }) => void events.push(`apiTokenRevoked:${reason}`),
      signInFailed: ({ reason }) => void events.push(`signInFailed:${reason}`),
    },
    ...extra,
  };
  return { config, adapter: base, sms, mail, events };
}

/** How one call is made. */
export interface CallInit {
  /** Send a urlencoded form (default: JSON with `accept: application/json`). */
  form?: boolean;
  /** The `Origin` header (default: the app's). */
  origin?: string;
  /** The socket peer (default 203.0.113.9). */
  peer?: string;
  /** The session cookie to present. */
  cookie?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/** What a call produced: the answer and the session cookie it set, if any. */
export interface CallResult {
  res: Response;
  cookie: string | undefined;
}

/**
 * Call one auth endpoint through the dispatcher, then flush `after()` work.
 *
 * @param h The harness.
 * @param method The method.
 * @param path The path (below the origin).
 * @param body A body for POST.
 * @param init Headers and the peer.
 * @returns The answer and the session cookie set.
 */
export async function call(
  h: NativeHarness,
  method: string,
  path: string,
  body?: Record<string, string>,
  init: CallInit = {},
): Promise<CallResult> {
  const headers = new Headers(init.headers);
  let payload: string | undefined;
  if (method !== "GET") {
    headers.set("origin", init.origin ?? ORIGIN);
    if (init.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      payload = new URLSearchParams(body).toString();
    } else {
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json");
      payload = JSON.stringify(body ?? {});
    }
  }
  if (init.cookie) headers.set("cookie", init.cookie);
  const request = new Request(new URL(path, ORIGIN), { method, headers, body: payload });
  setRemoteAddr(request, { transport: "tcp", hostname: init.peer ?? "203.0.113.9", port: 443 });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, h.config));
  await runDeferred(ctx);
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith(SESSION_COOKIE))
    ?.split(";")[0];
  return { res: res ?? new Response(null, { status: 404 }), cookie };
}

/**
 * POST a JSON (or form) body.
 *
 * @param h The harness.
 * @param path The path.
 * @param body The body.
 * @param init Headers and the peer.
 * @returns The answer and the session cookie set.
 */
export function post(
  h: NativeHarness,
  path: string,
  body: Record<string, string>,
  init: CallInit = {},
): Promise<CallResult> {
  return call(h, "POST", path, body, init);
}

/**
 * The session a cookie carries, or `null`.
 *
 * @param h The harness.
 * @param cookie The `name=value` cookie.
 * @returns The session.
 */
export async function sessionOf(
  h: NativeHarness,
  cookie: string | undefined,
): Promise<AuthSession | null> {
  if (!cookie) return null;
  const request = new Request(`${ORIGIN}/`, { headers: { cookie } });
  return await runWithContext(createRequestContext(request), () => readAuthSession(h.config));
}

/**
 * Everything a client can see of an answer.
 *
 * @param res The answer.
 * @returns Status, `Location` and body.
 */
export async function visible(res: Response): Promise<[number, string | null, string]> {
  return [res.status, res.headers.get("location"), await res.text()];
}
