/**
 * The sign-in and sign-out flows the `next-auth` surface starts — from a form POST to the
 * handlers, or from the server-side `signIn()` / `signOut()` in a Server Action — run through
 * denext's own auth endpoints in-process: a request to `{basePath}/…` on the app's origin,
 * carrying the caller's cookies and socket peer (so rate limits key on the real client). The
 * answer is a URL to go to, never a raw denext response.
 *
 * @module
 */

import { safeRedirectLocation } from "../../server/config.ts";
import { copyRemoteAddr } from "../../server/remote-addr.ts";
import { currentContext } from "../../server/request-context.ts";
import { handleAuthRequest } from "../../server/auth/routes.ts";
import type { ActiveNextAuth } from "./state.ts";
import type { ProviderDescriptor } from "./providers/shared.ts";

/** Headers a self-request inherits from the request that started it. */
const INHERITED = ["cookie", "user-agent", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"];

/** The app's origin: `AUTH_URL`'s, else the request's own. */
export function appOrigin(active: ActiveNextAuth, request: Request): string {
  return active.denext.canonicalOrigin
    ? new URL(active.denext.canonicalOrigin).origin
    : new URL(request.url).origin;
}

/**
 * Run one denext auth endpoint in-process for `parent`.
 *
 * @param active The instance.
 * @param parent The request that started the flow.
 * @param path The path under the base path (`/signin/github?callbackUrl=…`).
 * @param body Form fields for a POST; omit for a GET.
 * @returns denext's response.
 */
async function selfRequest(
  active: ActiveNextAuth,
  parent: Request,
  path: string,
  body?: Record<string, string>,
): Promise<Response> {
  const origin = appOrigin(active, parent);
  const url = new URL(`${active.basePath}${path}`, origin);
  const headers = new Headers({ accept: "text/html", origin, host: url.host });
  for (const name of INHERITED) {
    const value = parent.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (body) headers.set("content-type", "application/x-www-form-urlencoded");
  const request = new Request(url, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? new URLSearchParams(body) : undefined,
  });
  copyRemoteAddr(parent, request);
  const res = await handleAuthRequest(request, active.denext);
  return res ?? new Response(null, { status: 404 });
}

/** The `Location` of a redirect answer, or `null`. */
function locationOf(res: Response): string | null {
  return res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
}

/** denext's `?error=` codes → the Auth.js codes an app's pages switch on. */
const ERROR_CODES: Record<string, string> = {
  access_denied: "AccessDenied",
  account_not_linked: "OAuthAccountNotLinked",
  config: "Configuration",
  invalid_state: "OAuthCallbackError",
  invalid_request: "OAuthCallbackError",
  oauth_failed: "OAuthCallbackError",
  provider_error: "OAuthCallbackError",
  invalid_credentials: "CredentialsSignin",
};

/**
 * A `Location` with denext's `?error=` code renamed to Auth.js's.
 *
 * @param location The location denext answered.
 * @returns The same location, its `error` translated.
 */
export function translateErrorLocation(location: string): string {
  const url = new URL(location, "http://denext.invalid");
  const code = url.searchParams.get("error");
  const mapped = code && Object.hasOwn(ERROR_CODES, code) ? ERROR_CODES[code] : undefined;
  if (!mapped) return location;
  url.searchParams.set("error", mapped);
  return url.origin === "http://denext.invalid" ? url.pathname + url.search + url.hash : url.href;
}

/**
 * Where a caller-supplied `callbackUrl` may send the browser: through the app's `redirect`
 * callback (a throw falls back to the base URL), then — whatever it answered — kept to a
 * same-origin path. Auth.js would follow a foreign URL the callback returned; denext doesn't.
 *
 * @param active The instance.
 * @param request The request (for the base URL).
 * @param requested The `callbackUrl` or `redirectTo`.
 * @returns A same-origin path.
 */
export async function safeCallbackUrl(
  active: ActiveNextAuth,
  request: Request,
  requested: string | null | undefined,
): Promise<string> {
  const baseUrl = appOrigin(active, request);
  let url = requested || "/";
  const redirect = active.config.callbacks?.redirect;
  if (redirect) {
    try {
      url = await redirect({ url: new URL(url, baseUrl).href, baseUrl });
    } catch {
      url = baseUrl;
    }
  }
  return sameOriginPath(url, baseUrl);
}

/** `url` as a same-origin path; anything foreign (or unparsable) becomes `/`. */
function sameOriginPath(url: string, baseUrl: string): string {
  try {
    const target = new URL(url, baseUrl);
    if (target.origin !== new URL(baseUrl).origin) return "/";
    return safeRedirectLocation(target.pathname + target.search + target.hash);
  } catch {
    return "/";
  }
}

/** The outcome of a flow: where to send the browser, and the Auth.js error when it failed. */
export interface FlowResult {
  /** Where to go next. */
  url: string;
  /** The Auth.js error code, when the flow was refused. */
  error?: string;
}

/** The sign-in page with an error (and the callback URL to come back to). */
function signInError(active: ActiveNextAuth, code: string, callbackUrl: string): FlowResult {
  const page = active.denext.pages?.signIn ?? `${active.basePath}/signin`;
  const url = new URL(page, "http://denext.invalid");
  url.searchParams.set("error", code);
  if (code === "CredentialsSignin") url.searchParams.set("code", "credentials");
  url.searchParams.set("callbackUrl", callbackUrl);
  return { url: url.pathname + url.search, error: code };
}

/**
 * The authorization-request parameters the flow itself owns, which a per-call
 * `authorizationParams` may never set: replacing one would break the binding of the response to
 * this browser (`state`, `nonce`, PKCE), send the code elsewhere (`redirect_uri`, a request
 * object), or change the client or the response type.
 */
const RESERVED_AUTHORIZATION_PARAMS = new Set([
  "client_id",
  "client_secret",
  "code_challenge",
  "code_challenge_method",
  "code_verifier",
  "nonce",
  "redirect_uri",
  "request",
  "request_uri",
  "response_mode",
  "response_type",
  "state",
]);

/** A per-call `authorizationParams` value as Auth.js accepts it. */
export type AuthorizationParamsInput =
  | Record<string, string>
  | string
  | URLSearchParams
  | string[][]
  | undefined;

/**
 * A per-call `authorizationParams` (`signIn("google", {}, { prompt: "login" })`) as the
 * parameters that may be added to the provider's authorization URL: every pair but the reserved
 * ones (compared case-insensitively).
 *
 * @param input A record, a query string, `URLSearchParams` or pairs.
 * @returns The safe parameters (empty when there are none).
 */
export function safeAuthorizationParams(input: AuthorizationParamsInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  let pairs: [string, string][];
  try {
    pairs = [...new URLSearchParams(input as ConstructorParameters<typeof URLSearchParams>[0])];
  } catch {
    return out;
  }
  for (const [key, value] of pairs) {
    if (key && !RESERVED_AUTHORIZATION_PARAMS.has(key.toLowerCase())) out[key] = String(value);
  }
  return out;
}

/** The provider redirect `location` with `params` added — never one back to the app (an error). */
function withAuthorizationParams(
  location: string,
  origin: string,
  params: Record<string, string>,
): string {
  if (Object.keys(params).length === 0) return location;
  const url = new URL(location, origin);
  if (url.origin === new URL(origin).origin) return location;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/**
 * Start (OAuth / OIDC), send (email) or complete (credentials) a sign-in with `provider`.
 *
 * @param active The instance.
 * @param request The request that asked.
 * @param provider The provider.
 * @param fields The submitted fields (credentials, `email`), without `csrfToken`.
 * @param callbackUrl The already-safe path to land on.
 * @param authorizationParams Extra authorization-request parameters for an OAuth / OIDC
 *   provider, already filtered by {@linkcode safeAuthorizationParams}.
 * @returns Where to go: the provider, the "check your email" page, the landing path, or the
 *   sign-in page with an error.
 */
export async function runSignIn(
  active: ActiveNextAuth,
  request: Request,
  provider: ProviderDescriptor,
  fields: Record<string, string>,
  callbackUrl: string,
  authorizationParams: Record<string, string> = {},
): Promise<FlowResult> {
  const id = encodeURIComponent(provider.id);
  if (provider.type === "credentials") {
    const res = await selfRequest(active, request, `/callback/${id}`, { ...fields, callbackUrl });
    const to = locationOf(res);
    await res.body?.cancel();
    return to ? { url: to } : signInError(active, "CredentialsSignin", callbackUrl);
  }
  if (provider.type === "email") {
    const email = fields.email ?? "";
    const res = await selfRequest(active, request, `/callback/${id}`, { email, callbackUrl });
    await res.body?.cancel();
    if (res.status === 429 || !locationOf(res)) {
      return signInError(active, "EmailSignin", callbackUrl);
    }
    const verify = active.denext.pages?.verifyRequest ?? `${active.basePath}/verify-request`;
    return { url: `${verify}?provider=${id}&type=email` };
  }
  const res = await selfRequest(
    active,
    request,
    `/signin/${id}?callbackUrl=${encodeURIComponent(callbackUrl)}`,
  );
  const to = locationOf(res);
  await res.body?.cancel();
  if (!to) return signInError(active, "Configuration", callbackUrl);
  const origin = appOrigin(active, request);
  return { url: translateErrorLocation(withAuthorizationParams(to, origin, authorizationParams)) };
}

/**
 * End the session (denext's sign-out: the cookie, the stored record, the `signOut` event).
 *
 * @param active The instance.
 * @param request The request that asked.
 * @param callbackUrl The already-safe path to land on.
 * @returns Where to go.
 */
export async function runSignOut(
  active: ActiveNextAuth,
  request: Request,
  callbackUrl: string,
): Promise<FlowResult> {
  const res = await selfRequest(
    active,
    request,
    `/signout?callbackUrl=${encodeURIComponent(callbackUrl)}`,
    {},
  );
  await res.body?.cancel();
  return { url: locationOf(res) ?? callbackUrl };
}

/**
 * The request a server-side `signIn()` / `signOut()` runs for: the current request context's.
 *
 * @param what The calling API, for the error message.
 * @returns The request.
 * @throws {Error} Outside a request (a Server Action, a route handler, middleware).
 */
export function contextRequest(what: string): Request {
  const request = currentContext()?.request;
  if (!request) {
    throw new Error(
      `next-auth: ${what}() must run during a request (a Server Action, a route handler)`,
    );
  }
  return request;
}
