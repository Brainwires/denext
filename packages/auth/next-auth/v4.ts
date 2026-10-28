/**
 * NextAuth.js v4's server API on the same instance as v5's: the route handler
 * `NextAuth(authOptions)` returns (an App Router `GET` / `POST`, or a Pages Router API route's
 * `(req, res)`), `NextAuth(req, res, authOptions)` called straight from a Pages API route, and
 * `getServerSession()` — in a Server Component or route handler as `getServerSession(authOptions)`,
 * in `getServerSideProps` or an API route as `getServerSession(req, res, authOptions)`.
 *
 * Every endpoint is the v5 handlers' (the same CSRF, same-origin, callback-URL and cookie rules);
 * a Pages API route's Node-style `req` / `res` are only translated to a `Request` and back.
 *
 * @module
 */

import { copyRemoteAddr } from "@denext/denext/auth-kit";
import { createRequestContext, currentContext, runWithContext } from "@denext/denext/auth-kit";
import { createHandlers } from "./handlers.ts";
import { bindInstance, instanceFor } from "./instance.ts";
import { currentAuthJsSession } from "./session.ts";
import type { ActiveNextAuth } from "./state.ts";
import type { NextAuthConfig, Session } from "./types.ts";

/** A header bag as Node (`IncomingMessage`) and the Pages API `req` carry it. */
type NodeHeaders = Record<string, string | string[] | undefined>;

/** The request half of a Pages API route or `getServerSideProps` (Node-style or a `Request`). */
export interface NodeLikeRequest {
  /** The method. */
  method?: string;
  /** The path and query (`/api/auth/session?x=1`). */
  url?: string;
  /** The request headers (a Node-style bag, or `Headers`). */
  headers: Record<string, string | string[] | undefined> | Headers;
  /** The parsed body (a form or JSON object), or the raw text. */
  body?: unknown;
}

/** The response half of a Pages API route (`NextApiResponse`'s subset the handler uses). */
export interface NodeLikeResponse {
  /** Set the status (chainable). */
  status?: (code: number) => unknown;
  /** The status, when `status()` is absent. */
  statusCode?: number;
  /** Set a header (an array for repeated `set-cookie`). */
  setHeader: (name: string, value: string | string[]) => unknown;
  /** Finish with a body. */
  end: (body?: string) => unknown;
}

/** The v4 route handler: an App Router `GET` / `POST`, or a Pages API route's default export. */
export type NextAuthV4Handler = (
  request: Request | NodeLikeRequest,
  contextOrResponse?: unknown,
) => Promise<Response | undefined>;

/** One header of a Node-style bag, joined when repeated. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

/** A Node-style header bag (or `Headers`) as `Headers`. */
function toHeaders(headers: NodeHeaders | Headers | undefined): Headers {
  if (headers instanceof Headers) return new Headers(headers);
  const out = new Headers();
  for (const [name, raw] of Object.entries(headers ?? {})) {
    const value = headerValue(raw);
    if (value !== undefined) out.set(name, value);
  }
  return out;
}

/** The string fields of a parsed body. */
function formFields(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) return out;
  for (const [key, value] of Object.entries(body)) if (typeof value === "string") out[key] = value;
  return out;
}

/** The body a Pages API route's parsed `req.body` becomes again, with its content type. */
function rebuiltBody(req: NodeLikeRequest): { body?: BodyInit; type?: string } {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || req.body === undefined || req.body === null) {
    return {};
  }
  if (typeof req.body === "string") return { body: req.body };
  return {
    body: new URLSearchParams(formFields(req.body)),
    type: "application/x-www-form-urlencoded",
  };
}

/**
 * The origin a Node-style request was made to: the current request's (the pipeline's own), else
 * the one its `Host` header names.
 */
function nodeOrigin(headers: Headers): string {
  const current = currentContext()?.request;
  if (current) return new URL(current.url).origin;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
    ? "https"
    : "http";
  return `${proto}://${headers.get("host") ?? "localhost"}`;
}

/**
 * A Pages API route's (or `getServerSideProps`') Node-style `req` as a `Request` on the app's
 * origin; a `Request` is returned as it is.
 *
 * @param req The request.
 * @returns The `Request`.
 */
function toWebRequest(req: Request | NodeLikeRequest): Request {
  if (req instanceof Request) return req;
  const headers = toHeaders(req.headers);
  const { body, type } = rebuiltBody(req);
  if (type) headers.set("content-type", type);
  headers.delete("content-length");
  const request = new Request(new URL(req.url ?? "/", nodeOrigin(headers)), {
    method: req.method ?? "GET",
    headers,
    body,
  });
  const current = currentContext()?.request;
  if (current) copyRemoteAddr(current, request);
  return request;
}

/** Write `response` onto a Node-style `res`: status, headers (every `Set-Cookie`), body. */
async function writeNodeResponse(response: Response, res: NodeLikeResponse): Promise<void> {
  if (typeof res.status === "function") res.status(response.status);
  else res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  res.end(await response.text());
}

/** Answer one request with `active`'s handlers. */
function serve(active: ActiveNextAuth, request: Request): Promise<Response> {
  bindInstance(active);
  const handlers = createHandlers(active);
  return request.method === "GET" ? handlers.GET(request) : handlers.POST(request);
}

/**
 * The v4 route handler: `(request, { params })` in the App Router answers a `Response`;
 * `(req, res)` in a Pages API route writes it onto `res` instead.
 *
 * @param resolve The instance that answers a request (a static config's, or a lazy one's).
 * @returns The handler.
 */
export function v4Handler(
  resolve: (request: Request) => Promise<ActiveNextAuth> | ActiveNextAuth,
): NextAuthV4Handler {
  return async (req, second) => {
    const request = toWebRequest(req);
    const response = await serve(await resolve(request), request);
    if (!isNodeResponse(second)) return response;
    await writeNodeResponse(response, second);
    return undefined;
  };
}

/**
 * `NextAuth(req, res, authOptions)` called straight from a Pages API route: answer it onto `res`.
 *
 * @param req The Node-style request.
 * @param res The Node-style response.
 * @param options The v4 `authOptions`.
 */
export async function servePagesApi(
  req: NodeLikeRequest | Request,
  res: NodeLikeResponse,
  options: NextAuthConfig,
): Promise<void> {
  await v4Handler(() => instanceFor(options))(req, res);
}

/**
 * Whether `value` is a Pages API / Node `res` (`NextAuth(req, res, options)`'s second argument).
 *
 * @param value The value.
 * @returns `true` for an object with `setHeader` and `end`.
 */
export function isNodeResponse(value: unknown): value is NodeLikeResponse {
  return typeof value === "object" && value !== null &&
    typeof (value as NodeLikeResponse).setHeader === "function" &&
    typeof (value as NodeLikeResponse).end === "function";
}

/** `getServerSession`'s arguments: `(options)` or `(req, res, options)`. */
export type GetServerSessionArgs =
  | [options: NextAuthConfig]
  | [req: Request | NodeLikeRequest, res: unknown, options: NextAuthConfig];

/** The options of a `getServerSession(…)` call, or a clear error for a call without them. */
function sessionOptions(args: unknown[]): NextAuthConfig {
  const options = args.length >= 3 ? args[2] : args[0];
  if (typeof options !== "object" || options === null || !("providers" in options)) {
    throw new TypeError(
      "next-auth: getServerSession() takes the authOptions: getServerSession(authOptions) or " +
        "getServerSession(req, res, authOptions)",
    );
  }
  return options as NextAuthConfig;
}

/**
 * The current request's session (v4's `getServerSession`), read through the app's `jwt` and
 * `session` callbacks. Inside a request (a Server Component, a route handler, a Server Action,
 * `getServerSideProps`, an API route) it reads that request's cookie; given a `req` outside one,
 * it reads `req`'s.
 *
 * @param args `(authOptions)`, or `(req, res, authOptions)`.
 * @returns The session, or `null`.
 */
export function getServerSession<S = Session>(...args: GetServerSessionArgs): Promise<S | null>;
export async function getServerSession(...args: unknown[]): Promise<Session | null> {
  const active = instanceFor(sessionOptions(args));
  const read = () => {
    bindInstance(active);
    return currentAuthJsSession(active, { persist: false });
  };
  if (currentContext() || args.length < 3) return await read();
  const request = toWebRequest(args[0] as Request | NodeLikeRequest);
  return await runWithContext(createRequestContext(request), read);
}
