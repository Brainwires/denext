// The per-session token of a `denext dev` server bound to a non-loopback address (`--lan`,
// `--host <lan ip>`, `--host 0.0.0.0`).
//
// The dev origin gate (`devOriginAllowed`) defends against a hostile PAGE in the developer's
// browser; it cannot tell a browser from any other client, because `Host`, `Origin` and
// `Sec-Fetch-Site` are all just headers to a client that is not a browser. Once the server
// listens on a LAN address, every machine on that network is such a client, and the dev server
// hands out the app's transformed source (server-only modules included), the captured console
// and an editor launcher. So a non-loopback bind carries a random token: the URL `denext dev`
// prints (and its QR code) holds it as `?__denext_dev=<token>`; the first request with it sets
// an HttpOnly, SameSite=Strict cookie and redirects to the clean URL, and from then on every
// request a peer that is not this machine's loopback makes must carry the cookie, the
// `x-denext-dev-token` header (dev clients that are not browsers: the desktop dev proxy) or the
// query parameter. The peer is the socket's address, never the `Host` header. A loopback bind
// has no token and nothing changes.

import { isLoopbackHost } from "../../utils/loopback.ts";
import { remoteAddrOf } from "../../server/remote-addr.ts";

/** The query parameter the printed LAN URL carries the token in. */
export const DEV_TOKEN_PARAM = "__denext_dev";
/** The cookie the first tokened request sets. */
export const DEV_TOKEN_COOKIE = "__denext_dev";
/** The header a non-browser dev client (the desktop dev proxy) sends the token in. */
export const DEV_TOKEN_HEADER = "x-denext-dev-token";
/**
 * The environment variable a parent CLI (`denext mobile dev`, `denext desktop dev`) hands the
 * token to the `denext dev` it spawns in, so it knows the token without parsing output.
 */
export const DEV_TOKEN_ENV = "DENEXT_DEV_TOKEN";

/** A token's shape: 32–128 lowercase hex characters. */
const TOKEN_SHAPE = /^[0-9a-f]{32,128}$/;

/** A fresh random token (256 bits, hex). */
export function newDevToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The token a dev server bound to `hostname` uses: none for a loopback (or unspecified) bind;
 * else {@linkcode DEV_TOKEN_ENV} when it holds a well-formed token, else a fresh one.
 *
 * @param hostname The address the server binds, as given (`--host`).
 * @param env Reads an environment variable (default `Deno.env.get`, `undefined` without permission).
 * @returns The token, or `undefined` for a loopback bind.
 */
export function devSessionToken(
  hostname: string | undefined,
  env: (name: string) => string | undefined = readEnv,
): string | undefined {
  if (!hostname || isLoopbackHost(hostname)) return undefined;
  const given = env(DEV_TOKEN_ENV)?.trim().toLowerCase();
  return given && TOKEN_SHAPE.test(given) ? given : newDevToken();
}

function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * `url` with the token as its {@linkcode DEV_TOKEN_PARAM} query parameter (unchanged without one).
 *
 * @param url A dev server URL (`http://192.168.1.5:3000`).
 * @param token The session token, if any.
 * @returns The URL a device opens.
 */
export function withDevTokenParam(url: string, token: string | undefined): string {
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set(DEV_TOKEN_PARAM, token);
  return u.href;
}

/** Constant-time string equality (both sides are short ASCII tokens). */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The value of cookie `name` in a `Cookie` header, or undefined. */
function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Whether `request` comes from this machine: its socket peer is a loopback address. A request
 * that did not arrive through denext's server loop (an in-process caller) has no recorded peer;
 * then its `Host` decides, as it always has for such callers.
 */
function fromLoopback(request: Request, url: URL): boolean {
  const peer = remoteAddrOf(request);
  return peer !== undefined ? isLoopbackHost(peer) : isLoopbackHost(url.hostname);
}

/** Why a request without the token is refused (the body of the 403). */
const NEED_TOKEN = "denext dev: this dev server is bound to a network address and needs its " +
  "session token. Open the URL `denext dev` printed (it ends in ?" + DEV_TOKEN_PARAM + "=…), or " +
  "scan its QR code.\n";

/**
 * The token gate for one request: `null` to let it through, else the response to send — a 403
 * without the token, or the redirect that trades the token in the URL for the cookie.
 *
 * @param request The incoming request.
 * @param token The server's session token (`undefined`: a loopback bind, no gate).
 * @returns `null`, or the response.
 */
export function devTokenGate(request: Request, token: string | undefined): Response | null {
  if (!token) return null;
  const url = new URL(request.url);
  if (fromLoopback(request, url)) return null;
  const query = url.searchParams.get(DEV_TOKEN_PARAM);
  if (query !== null && sameToken(query, token)) {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    // A navigation: set the cookie and drop the token from the address bar (and history).
    url.searchParams.delete(DEV_TOKEN_PARAM);
    if (isWebSocketUpgrade(request)) return null;
    return new Response(null, {
      status: 303,
      headers: {
        location: url.pathname + url.search + url.hash,
        "set-cookie": `${DEV_TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
        "cache-control": "no-store",
      },
    });
  }
  const header = request.headers.get(DEV_TOKEN_HEADER);
  const cookie = cookieValue(request.headers.get("cookie"), DEV_TOKEN_COOKIE);
  if (
    (header !== null && sameToken(header, token)) ||
    (cookie !== undefined && sameToken(cookie, token))
  ) {
    return null;
  }
  return new Response(NEED_TOKEN, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Whether the request is a WebSocket upgrade (reading headers can throw once upgraded). */
function isWebSocketUpgrade(request: Request): boolean {
  try {
    return request.headers.get("upgrade")?.toLowerCase() === "websocket";
  } catch {
    return false;
  }
}

/**
 * `handler` behind {@linkcode devTokenGate}: every request a non-loopback peer makes, the
 * `/_denext/*` endpoints, the module graph, the live-reload stream, the Live socket and the
 * pages alike, carries the token or is refused.
 *
 * @param handler The dev server's request handler.
 * @param token The session token (`undefined`: the handler unchanged).
 * @returns The gated handler.
 */
export function withDevTokenGate(
  handler: (request: Request) => Response | Promise<Response>,
  token: string | undefined,
): (request: Request) => Response | Promise<Response> {
  if (!token) return handler;
  return (request) => devTokenGate(request, token) ?? handler(request);
}

/**
 * The headers the desktop dev proxy adds upstream: the dev server's session token when the dev
 * URL carries one (`?__denext_dev=…`, a LAN dev server under `denext desktop dev --lan`).
 *
 * @param devUrl The dev server URL (`DENEXT_DESKTOP_DEV_URL`).
 * @returns `{ "x-denext-dev-token": token }`, or `{}`.
 */
export function devProxyTokenHeaders(devUrl: string): Record<string, string> {
  try {
    const token = new URL(devUrl).searchParams.get(DEV_TOKEN_PARAM);
    return token ? { [DEV_TOKEN_HEADER]: token } : {};
  } catch {
    return {};
  }
}
