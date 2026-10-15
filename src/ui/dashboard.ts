// The password gate of `denext dashboard` — the stack's Studio-style dashboard, which is
// `denext ui`'s Database section served behind `DASHBOARD_PASSWORD` instead of a launch token.
//
// The layers, in the order `server.ts` applies them:
//
//   1. bind          — `127.0.0.1` unless `--host` says otherwise (the stack's container binds
//                      `0.0.0.0` and compose publishes it on the host's loopback only).
//   2. host/origin   — the Host must be a loopback name or the host of a configured public origin
//                      (`--origin https://dash.example.com`, behind a TLS proxy); a browser's
//                      `Sec-Fetch-Site` must be same-origin (or `none`, for a read).
//   3. login         — `POST /login` with the password: refused without a same-origin `Origin`
//                      and the login form's CSRF token (double-submitted through a short-lived
//                      `HttpOnly` cookie, so a cross-site page cannot sign a browser in), rate
//                      limited per peer and overall (a failure counts; a success clears the
//                      peer's count), and checked in constant time (HMAC-SHA256 of both values
//                      under a per-process key, compared without an early exit). Nothing is
//                      checked while a peer is limited, so the limit is not an oracle either.
//   4. session       — a fresh 256-bit id per sign-in, kept in memory, in an `HttpOnly;
//                      SameSite=Strict` cookie: `__Host-`-prefixed and `Secure` when the request
//                      reached the dashboard over https (directly, or through a configured https
//                      `--origin`), unprefixed and without `Secure` on a plain-http loopback
//                      address, so no browser has to bend its rules for it. A plain-http origin on
//                      any other host is refused at startup: the password would cross a network
//                      in the clear. It ends after 30 idle minutes or 12 hours, and at
//                      `POST /logout`. Its CSRF token is HMAC-SHA256(id, "csrf"), as `denext ui`'s.
//   5. CSRF          — every mutation also passes `checkCsrf` (same-origin + the token).
//
// Without a password (none set, or one shorter than 12 characters) the dashboard is locked: the
// login page says how to set one and every sign-in is refused.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { verifyOrigin } from "../server/origin-check.ts";
import { remoteAddrOf } from "../server/remote-addr.ts";
import { UI_CSS_PATH } from "./layout.ts";
import { renderView } from "./view.ts";
import { boundedRequest } from "./body.ts";
import {
  constantTimeEqual,
  deriveCsrf,
  newToken,
  UI_CSRF_FIELD,
  type UiCookie,
} from "./security.ts";

/** The session cookie (on https it carries {@linkcode DASH_SECURE_PREFIX}). */
export const DASH_COOKIE = "denext_dash";

/** The prefix a cookie set over https carries: `Secure`, `Path=/`, no `Domain` — host-locked. */
export const DASH_SECURE_PREFIX = "__Host-";

/** The login form's double-submit cookie (scoped to `/login`). */
export const DASH_LOGIN_COOKIE = "denext_dash_login";

/** Where the login form lives. */
export const DASH_LOGIN_PATH = "/login";

/** Where signing out posts. */
export const DASH_LOGOUT_PATH = "/logout";

/** The shortest password the dashboard accepts (what `denext stack passwd` requires). */
export const DASH_MIN_PASSWORD = 12;

/** A session ends after this long without a request. */
const IDLE_MS = 30 * 60_000;

/** A session ends this long after its sign-in, however busy. */
const ABSOLUTE_MS = 12 * 60 * 60_000;

/** The most sessions kept (the oldest is dropped first). */
const MAX_SESSIONS = 64;

/** Failed sign-ins one peer may make per window. */
const PEER_FAILURES = 5;

/** Failed sign-ins every peer together may make per window. */
const GLOBAL_FAILURES = 30;

/** The rate-limit window. */
const WINDOW_MS = 15 * 60_000;

/** The most peers the limiter tracks before it forgets the stalest. */
const MAX_PEERS = 10_000;

/** Options for the gate. */
export interface DashboardOptions {
  /** The dashboard password (`DASHBOARD_PASSWORD`); `null` or too short locks the dashboard. */
  readonly password: string | null;
  /**
   * Public origins the dashboard is also reached at, behind a reverse proxy
   * (`https://dash.example.com`): their hosts pass the Host check, and a mutation's `Origin`
   * must be the configured origin for its host.
   */
  readonly origins?: readonly string[];
}

/** One signed-in browser. */
interface DashSession {
  readonly csrf: string;
  readonly created: number;
  seen: number;
}

/** A peer's failures in the current window. */
interface Failures {
  count: number;
  resetAt: number;
}

/**
 * Counts failed sign-ins per peer and overall; a peer over its budget, or everyone once the
 * overall budget is spent, waits for the window to pass.
 */
export class LoginLimiter {
  #peers = new Map<string, Failures>();
  #global: Failures = { count: 0, resetAt: 0 };

  /**
   * @param perPeer Failures one peer may make per window.
   * @param overall Failures every peer together may make per window.
   * @param windowMs The window.
   */
  constructor(
    readonly perPeer = PEER_FAILURES,
    readonly overall = GLOBAL_FAILURES,
    readonly windowMs = WINDOW_MS,
  ) {}

  /**
   * How long `peer` must wait before it may try again.
   *
   * @param peer The peer's address.
   * @param now The clock.
   * @returns Seconds to wait, or 0 when it may try now.
   */
  retryAfter(peer: string, now = Date.now()): number {
    const wait = (f: Failures | undefined, max: number) =>
      f && f.resetAt > now && f.count >= max ? Math.ceil((f.resetAt - now) / 1000) : 0;
    return Math.max(wait(this.#peers.get(peer), this.perPeer), wait(this.#global, this.overall));
  }

  /**
   * Count one failed sign-in.
   *
   * @param peer The peer's address.
   * @param now The clock.
   */
  fail(peer: string, now = Date.now()): void {
    const bump = (f: Failures | undefined): Failures =>
      f && f.resetAt > now ? { count: f.count + 1, resetAt: f.resetAt } : {
        count: 1,
        resetAt: now + this.windowMs,
      };
    if (!this.#peers.has(peer) && this.#peers.size >= MAX_PEERS) {
      this.#peers.delete(this.#peers.keys().next().value!);
    }
    this.#peers.set(peer, bump(this.#peers.get(peer)));
    this.#global = bump(this.#global);
  }

  /**
   * Forget a peer's failures (it signed in).
   *
   * @param peer The peer's address.
   */
  reset(peer: string): void {
    this.#peers.delete(peer);
  }
}

/** One dashboard's credentials, sessions and limiter. */
export class DashboardGate {
  readonly #sessions = new Map<string, DashSession>();
  readonly #origins: Map<string, string>;
  readonly #password: string | null;
  #key: Promise<CryptoKey> | undefined;
  /** The sign-in limiter. */
  readonly limiter: LoginLimiter;

  /**
   * @param options The password and the public origins.
   * @param limiter The sign-in limiter (tests pass a tighter one).
   * @param compare The comparison of the two MACs (tests record its arguments).
   */
  constructor(
    options: DashboardOptions,
    limiter = new LoginLimiter(),
    readonly compare: (a: string, b: string) => boolean = constantTimeEqual,
  ) {
    const password = options.password ?? "";
    this.#password = password.length >= DASH_MIN_PASSWORD ? password : null;
    this.#origins = new Map();
    for (const origin of options.origins ?? []) {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`denext dashboard: --origin must be an http(s) origin, got ${origin}`);
      }
      if (parsed.protocol === "http:" && !loopbackHost(parsed.hostname)) {
        throw new Error(
          `denext dashboard: --origin ${parsed.origin} is plain http on a host other than this ` +
            "machine, so the password and the session cookie would cross the network in the " +
            "clear. Put a TLS proxy in front and pass its https origin.",
        );
      }
      this.#origins.set(parsed.host, parsed.origin);
    }
    this.limiter = limiter;
  }

  /** Whether no usable password is set (every sign-in is refused). */
  get locked(): boolean {
    return this.#password === null;
  }

  /**
   * Whether `hostname` may reach the dashboard: a loopback name, or a configured origin's host.
   *
   * @param url The request URL.
   * @returns Whether its host passes.
   */
  hostAllowed(url: URL): boolean {
    return loopbackHost(url.hostname) || this.#origins.has(url.host);
  }

  /**
   * The origin a mutation's `Origin` must equal: the configured origin for the request's host,
   * else the request's own (a loopback address).
   *
   * @param url The request URL.
   * @returns The origin.
   */
  canonicalOrigin(url: URL): string {
    return this.#origins.get(url.host) ?? url.origin;
  }

  /**
   * Whether the request reached the dashboard over https: directly, or through a configured
   * https `--origin` for its host (a TLS proxy forwarding plain http).
   *
   * @param url The request URL.
   * @returns Whether its cookies are `Secure` and `__Host-`-prefixed.
   */
  secure(url: URL): boolean {
    return url.protocol === "https:" || this.canonicalOrigin(url).startsWith("https:");
  }

  /**
   * Whether `presented` is the password — in constant time: both are MACed under a
   * per-process key first, so the comparison runs over two equal-length digests.
   *
   * @param presented What was typed.
   * @returns Whether it matches (always false while locked).
   */
  async check(presented: string): Promise<boolean> {
    const expected = this.#password;
    this.#key ??= crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const key = await this.#key;
    const mac = async (value: string) =>
      hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
    const [a, b] = await Promise.all([mac(presented), mac(expected ?? "")]);
    return this.compare(a, b) && expected !== null;
  }

  /**
   * Start a session.
   *
   * @param now The clock.
   * @returns The session id (the cookie's value).
   */
  async open(now = Date.now()): Promise<string> {
    this.#sweep(now);
    while (this.#sessions.size >= MAX_SESSIONS) {
      this.#sessions.delete(this.#sessions.keys().next().value!);
    }
    const id = newToken();
    this.#sessions.set(id, { csrf: await deriveCsrf(id), created: now, seen: now });
    return id;
  }

  /**
   * The session a request carries, refreshed — or `null` when it has none, or it ended.
   *
   * @param request The request.
   * @param now The clock.
   * @returns The credential (`secret` is the session id), or `null`.
   */
  session(request: Request, now = Date.now()): UiCookie | null {
    const secure = this.secure(new URL(request.url));
    const id = readCookie(request.headers.get("cookie"), cookieName(DASH_COOKIE, secure));
    if (id === null) return null;
    // A map lookup by the presented value: the id is 256 random bits, so a guess cannot be
    // narrowed by timing the lookup.
    const session = this.#sessions.get(id);
    if (!session) return null;
    if (now - session.seen > IDLE_MS || now - session.created > ABSOLUTE_MS) {
      this.#sessions.delete(id);
      return null;
    }
    session.seen = now;
    return { secret: id, csrf: session.csrf };
  }

  /**
   * End a session.
   *
   * @param id The session id.
   */
  close(id: string): void {
    this.#sessions.delete(id);
  }

  /** Drop every ended session. */
  #sweep(now: number): void {
    for (const [id, s] of this.#sessions) {
      if (now - s.seen > IDLE_MS || now - s.created > ABSOLUTE_MS) this.#sessions.delete(id);
    }
  }
}

/** Hex of `bytes`. */
function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether `hostname` (possibly a bracketed IPv6 literal) names the loopback interface. */
function loopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

/** The value of `name` in a `Cookie` header, or `null`. */
function readCookie(header: string | null, name: string): string | null {
  const prefix = `${name}=`;
  const hit = (header ?? "").split(/;\s*/).find((part) => part.startsWith(prefix));
  return hit === undefined ? null : hit.trim().slice(prefix.length);
}

/** A cookie's name: `__Host-`-prefixed over https. */
function cookieName(name: string, secure: boolean): string {
  return secure ? DASH_SECURE_PREFIX + name : name;
}

/**
 * A `Set-Cookie` value with the dashboard's attributes: `HttpOnly; SameSite=Strict` always, and
 * over https the `__Host-` name, `Secure` and `Path=/` (which the prefix requires).
 */
function cookie(
  name: string,
  value: string,
  options: { secure: boolean; path: string; maxAge?: number },
): string {
  const path = options.secure ? "/" : options.path;
  return `${cookieName(name, options.secure)}=${value}; HttpOnly;` +
    (options.secure ? " Secure;" : "") + ` SameSite=Strict; Path=${path}` +
    (options.maxAge === undefined ? "" : `; Max-Age=${options.maxAge}`);
}

// ── the login page ─────────────────────────────────────────────────────────

/** What the login page says above the form. */
type LoginNotice = "wrong" | "limited" | "locked" | "expired" | null;

const NOTICES: Record<Exclude<LoginNotice, null>, string> = {
  wrong: "That is not the dashboard password.",
  limited: "Too many failed sign-ins. Wait a few minutes, then try again.",
  locked: "The dashboard is locked: set DASHBOARD_PASSWORD (12 characters or more) with " +
    "`denext stack passwd --dashboard`, then restart the dashboard.",
  expired: "The sign-in form expired. Try again.",
};

/** The login document. */
function LoginPage(
  { csrf, notice, locked }: {
    readonly csrf: string;
    readonly notice: LoginNotice;
    readonly locked: boolean;
  },
): VNode {
  const message = notice ?? (locked ? "locked" : null);
  return h(
    "html",
    { lang: "en" },
    h(
      "head",
      null,
      h("meta", { charset: "utf-8" }),
      h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
      h("title", null, "Sign in · denext dashboard"),
      h("link", { rel: "stylesheet", href: UI_CSS_PATH }),
    ),
    h(
      "body",
      null,
      h(
        "main",
        { id: "main", class: "login" },
        h(
          "section",
          { class: "panel" },
          h("h1", null, "denext dashboard"),
          message ? h("p", { class: "note", role: "alert" }, NOTICES[message]) : null,
          h(
            "form",
            { method: "post", action: DASH_LOGIN_PATH },
            h("input", { type: "hidden", name: UI_CSRF_FIELD, value: csrf }),
            h(
              "div",
              { class: "field" },
              h("label", { for: "dash-password" }, "Password"),
              h("input", {
                type: "password",
                id: "dash-password",
                name: "password",
                autocomplete: "current-password",
                required: true,
                autofocus: true,
                disabled: locked,
              }),
            ),
            h("button", { type: "submit", disabled: locked }, "Sign in"),
          ),
        ),
      ),
    ),
  );
}

/** The login page response, with a fresh double-submit cookie. */
async function loginPage(
  gate: DashboardGate,
  notice: LoginNotice,
  status: number,
  secure: boolean,
): Promise<Response> {
  const pre = newToken();
  const csrf = await deriveCsrf(pre);
  const html = "<!doctype html>" +
    renderView(h(LoginPage, { csrf, notice, locked: gate.locked })).__html;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  headers.append(
    "set-cookie",
    cookie(DASH_LOGIN_COOKIE, pre, { secure, path: DASH_LOGIN_PATH, maxAge: 600 }),
  );
  return new Response(html, { status, headers });
}

/** The most a sign-in form may carry. */
const LOGIN_MAX_BYTES = 16_384;

/** A sign-in's fields, or `null` when it is not a form, is too large, or is malformed. */
async function formOf(request: Request): Promise<FormData | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/form-data|x-www-form-urlencoded/.test(type)) return null;
  const bounded = await boundedRequest(request, LOGIN_MAX_BYTES);
  if (bounded === null) return null;
  try {
    return await bounded.formData();
  } catch {
    return null;
  }
}

/**
 * `GET /login` (the form) and `POST /login` (sign in).
 *
 * @param request The request.
 * @param url Its URL.
 * @param gate The dashboard's gate.
 * @returns The login page, the refusal, or the 303 into the dashboard with a session cookie.
 */
export async function dashboardLogin(
  request: Request,
  url: URL,
  gate: DashboardGate,
): Promise<Response> {
  const secure = gate.secure(url);
  if (request.method === "GET" || request.method === "HEAD") {
    // Already signed in: straight in.
    if (gate.session(request)) return seeOther("/database");
    return await loginPage(gate, null, 200, secure);
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!verifyOrigin(request, { canonicalOrigin: gate.canonicalOrigin(url) })) {
    return new Response("forbidden origin", { status: 403 });
  }
  const form = await formOf(request);
  const pre = readCookie(request.headers.get("cookie"), cookieName(DASH_LOGIN_COOKIE, secure));
  const presented = form?.get(UI_CSRF_FIELD);
  if (
    form === null || pre === null || typeof presented !== "string" ||
    !constantTimeEqual(presented, await deriveCsrf(pre))
  ) {
    return await loginPage(gate, "expired", 403, secure);
  }
  if (gate.locked) return await loginPage(gate, "locked", 503, secure);
  const peer = remoteAddrOf(request) ?? "unknown";
  const wait = gate.limiter.retryAfter(peer);
  if (wait > 0) {
    const res = await loginPage(gate, "limited", 429, secure);
    res.headers.set("retry-after", String(wait));
    return res;
  }
  const password = form.get("password");
  if (typeof password !== "string" || !await gate.check(password)) {
    gate.limiter.fail(peer);
    return await loginPage(gate, "wrong", 401, secure);
  }
  gate.limiter.reset(peer);
  const id = await gate.open();
  const headers = new Headers({ location: "/database" });
  headers.append("set-cookie", cookie(DASH_COOKIE, id, { secure, path: "/" }));
  headers.append(
    "set-cookie",
    cookie(DASH_LOGIN_COOKIE, "", { secure, path: DASH_LOGIN_PATH, maxAge: 0 }),
  );
  return new Response(null, { status: 303, headers });
}

/**
 * `POST /logout`: end the session (the caller has already passed the CSRF gate).
 *
 * @param gate The dashboard's gate.
 * @param session The caller's session.
 * @param url The request URL (whether the cookie to clear is the https one).
 * @returns The 303 to the login page, the cookie cleared.
 */
export function dashboardLogout(gate: DashboardGate, session: UiCookie, url: URL): Response {
  gate.close(session.secret);
  const headers = new Headers({ location: DASH_LOGIN_PATH });
  headers.append(
    "set-cookie",
    cookie(DASH_COOKIE, "", { secure: gate.secure(url), path: "/", maxAge: 0 }),
  );
  return new Response(null, { status: 303, headers });
}

/** A 303 to `location`. */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
