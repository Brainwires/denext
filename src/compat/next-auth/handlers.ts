/**
 * `handlers.GET` / `handlers.POST` — the `app/api/auth/[...nextauth]/route.ts` endpoints. The
 * Auth.js-shaped ones are answered here (`session`, `csrf`, `providers`, the `signin` /
 * `signout` POSTs and the credentials callback, the built-in pages); everything else — the
 * OAuth / email callbacks, a sign-in started by GET — goes to denext's own endpoints, its
 * `?error=` codes renamed to Auth.js's.
 *
 * Every state-changing POST here needs both checks: denext's same-origin check and Auth.js's
 * double-submit `csrfToken`.
 *
 * @module
 */

import { readCappedBody, STALLED, TOO_LARGE } from "../../server/body.ts";
import { safeRedirectLocation } from "../../server/config.ts";
import { handleAuthRequest } from "../../server/auth/routes.ts";
import { isSameOrigin } from "../../server/auth/routes-shared.ts";
import { csrfToken, csrfTokenValid } from "./csrf.ts";
import {
  appOrigin,
  type FlowResult,
  runSignIn,
  runSignOut,
  safeAuthorizationParams,
  safeCallbackUrl,
  translateErrorLocation,
} from "./flows.ts";
import { errorPage, signInPage, signOutPage, verifyRequestPage } from "./pages.ts";
import type { ProviderDescriptor } from "./providers/shared.ts";
import { currentAuthJsSession } from "./session.ts";
import { type ActiveNextAuth, signInRecord } from "./state.ts";

/** The most a form POST here may carry. */
const MAX_FORM_BYTES = 64 * 1024;

/** A route handler: `(request) => Response`. */
export type RouteHandler = (request: Request) => Promise<Response>;

/** A JSON answer that is never cached. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The string-valued entries of a parsed body. */
function stringFields(parsed: unknown): Record<string, string> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Parse a body as JSON or a form, as its content type says; `null` when it isn't. */
function parseBody(request: Request, text: string): unknown {
  const isJson = (request.headers.get("content-type") ?? "").includes("json");
  try {
    return isJson ? JSON.parse(text || "{}") : Object.fromEntries(new URLSearchParams(text));
  } catch {
    return null;
  }
}

/** The string fields of a form or JSON body, or `null` when it is too large or unreadable. */
async function readFields(request: Request): Promise<Record<string, string> | null> {
  const bytes = await readCappedBody(request, MAX_FORM_BYTES);
  if (bytes === TOO_LARGE || bytes === STALLED) return null;
  const parsed = parseBody(request, new TextDecoder().decode(bytes));
  return parsed === null ? null : stringFields(parsed);
}

/** The answer to a flow: a redirect, or `{ url }` for a client that asked for JSON. */
function answer(request: Request, active: ActiveNextAuth, result: FlowResult): Response {
  if (request.headers.get("x-auth-return-redirect") === "1") {
    return json({ url: new URL(result.url, appOrigin(active, request)).href });
  }
  return new Response(null, {
    status: 302,
    headers: { location: result.url, "cache-control": "no-store" },
  });
}

/**
 * The fields of a POST that passed both CSRF checks, or the `403` it gets: a cross-origin
 * request, or one without this browser's `csrfToken`.
 */
async function checkedFields(
  active: ActiveNextAuth,
  request: Request,
): Promise<Record<string, string> | Response> {
  if (!isSameOrigin(request, active.denext)) return json({ error: "MissingCSRF" }, 403);
  const fields = await readFields(request);
  if (!fields) return json({ error: "invalid body" }, 400);
  if (!(await csrfTokenValid(active, fields.csrfToken))) return json({ error: "MissingCSRF" }, 403);
  const { csrfToken: _token, ...rest } = fields;
  return rest;
}

/**
 * `POST {basePath}/signin/:provider` and `/callback/:provider` (credentials). The POST URL's
 * query is the per-call `authorizationParams` (`next-auth/react`'s `signIn()` sends them there,
 * as Auth.js's does), filtered of the parameters the flow owns.
 */
async function postSignIn(
  active: ActiveNextAuth,
  request: Request,
  provider: ProviderDescriptor,
): Promise<Response> {
  const fields = await checkedFields(active, request);
  if (fields instanceof Response) return fields;
  const { callbackUrl, ...rest } = fields;
  const target = await safeCallbackUrl(
    active,
    request,
    callbackUrl ?? request.headers.get("referer"),
  );
  const extra = safeAuthorizationParams(new URL(request.url).searchParams);
  return answer(request, active, await runSignIn(active, request, provider, rest, target, extra));
}

/** `POST {basePath}/signout`. */
async function postSignOut(active: ActiveNextAuth, request: Request): Promise<Response> {
  const fields = await checkedFields(active, request);
  if (fields instanceof Response) return fields;
  const target = await safeCallbackUrl(active, request, fields.callbackUrl);
  return answer(request, active, await runSignOut(active, request, target));
}

/** `POST {basePath}/session` — `update(data)`: the `jwt` callback with `trigger: "update"`. */
async function postSession(active: ActiveNextAuth, request: Request): Promise<Response> {
  const fields = await checkedFields(active, request);
  if (fields instanceof Response) return fields;
  let data: unknown = fields.data;
  try {
    data = typeof fields.data === "string" ? JSON.parse(fields.data) : undefined;
  } catch { /* a plain string */ }
  return json(await currentAuthJsSession(active, { persist: true, update: { data } }));
}

/** `GET {basePath}/providers` in Auth.js's shape. */
function providersJson(active: ActiveNextAuth, request: Request): Response {
  const origin = appOrigin(active, request);
  const out: Record<string, unknown> = {};
  for (const p of active.providers) {
    out[p.id] = {
      id: p.id,
      name: p.name,
      type: p.type,
      signinUrl: `${origin}${active.basePath}/signin/${p.id}`,
      callbackUrl: `${origin}${active.basePath}/callback/${p.id}`,
    };
  }
  return json(out);
}

/** A plain redirect to an app-configured page (kept a safe `Location`). */
function redirectTo(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: safeRedirectLocation(location), "cache-control": "no-store" },
  });
}

/**
 * Where a sign-in that just created its user lands: `pages.newUser`, carrying the landing path
 * as `callbackUrl` (as Auth.js does) — `null` when there is no such page, the user isn't new
 * or the sign-in failed.
 */
function newUserLocation(active: ActiveNextAuth, location: string): string | null {
  const page = active.config.pages?.newUser;
  if (!page || signInRecord().isNewUser !== true) return null;
  if (new URL(location, "http://denext.invalid").searchParams.has("error")) return null;
  const separator = page.includes("?") ? "&" : "?";
  return safeRedirectLocation(`${page}${separator}callbackUrl=${encodeURIComponent(location)}`);
}

/**
 * Hand the request to denext's endpoints, renaming the `?error=` codes in a redirect — and
 * sending a first sign-in (an OAuth or email callback that created the user) to
 * `pages.newUser`.
 */
async function delegate(active: ActiveNextAuth, request: Request): Promise<Response> {
  const res = await handleAuthRequest(request, active.denext);
  if (!res) return json({ error: "not found" }, 404);
  const location = res.headers.get("location");
  if (!location || res.status < 300 || res.status >= 400) return res;
  const headers = new Headers(res.headers);
  headers.set("location", newUserLocation(active, location) ?? translateErrorLocation(location));
  return new Response(res.body, { status: res.status, headers });
}

/** `GET {basePath}/signout`: the app's own sign-out page (`pages.signOut`), else the built-in one. */
async function signOutGet(active: ActiveNextAuth, query: URLSearchParams): Promise<Response> {
  const page = active.config.pages?.signOut;
  return page ? redirectTo(page) : signOutPage(active.basePath, await csrfToken(active), query);
}

/** The GET endpoints the shim answers itself, by action. */
async function handleGet(
  active: ActiveNextAuth,
  request: Request,
  action: string,
  query: URLSearchParams,
): Promise<Response | null> {
  switch (action) {
    case "session":
      return json(await currentAuthJsSession(active, { persist: true }));
    case "csrf":
      return json({ csrfToken: await csrfToken(active) });
    case "providers":
      return providersJson(active, request);
    case "signin":
      return signInPage(active.basePath, active.providers, await csrfToken(active), query);
    case "signout":
      return await signOutGet(active, query);
    case "verify-request":
      return verifyRequestPage();
    case "error":
      return errorPage(query);
  }
  return null;
}

/** The POST endpoints the shim answers itself. */
function handlePost(
  active: ActiveNextAuth,
  request: Request,
  action: string,
  providerId: string | undefined,
): Promise<Response> | null {
  if (!providerId) {
    if (action === "signout") return postSignOut(active, request);
    return action === "session" ? postSession(active, request) : null;
  }
  const provider = active.providers.find((p) => p.id === providerId);
  const ours = action === "signin" || (action === "callback" && provider?.type === "credentials");
  return provider && ours ? postSignIn(active, request, provider) : null;
}

/**
 * The route handlers for `app/api/auth/[...nextauth]/route.ts`.
 *
 * @param active The instance.
 * @returns `{ GET, POST }`.
 */
export function createHandlers(active: ActiveNextAuth): { GET: RouteHandler; POST: RouteHandler } {
  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const prefix = `${active.basePath}/`;
    if (!url.pathname.startsWith(prefix)) return json({ error: "not found" }, 404);
    const [action, rawProvider, ...more] = url.pathname.slice(prefix.length).split("/");
    let providerId: string | undefined;
    try {
      providerId = rawProvider ? decodeURIComponent(rawProvider) : undefined;
    } catch {
      return json({ error: "not found" }, 404);
    }
    if (more.length === 0) {
      const own = request.method === "GET" && !providerId
        ? await handleGet(active, request, action, url.searchParams)
        : request.method === "POST"
        ? await handlePost(active, request, action, providerId)
        : null;
      if (own) return own;
    }
    return await delegate(active, request);
  };
  return { GET: route, POST: route };
}
