// The six-layer local security model of `denext ui`. The UI is a *state-writing* local web
// server, so it is defended like one even though it only ever listens on loopback:
//
//   1. bind          — `127.0.0.1` only, never `--host` (enforced in `server.ts`).
//   2. host/origin   — {@linkcode uiOriginAllowed}: the Host the browser sent must be a loopback
//                      name (DNS-rebinding defence, cf. CVE-2025-48068) and a present
//                      `Sec-Fetch-Site` must say `same-origin` (or `none` — the address bar —
//                      for a read). Mirrors the dev server's
//                      `devOriginAllowed` rule; re-implemented here (with no `allowedDevOrigins`
//                      list, which the UI has no concept of) because
//                      `src/build/dev-server/dev-endpoints.ts` transitively imports esbuild and
//                      `denext ui` must never load the bundler.
//   3. session token — a per-launch 256-bit token handed over ONCE in `?t=` and exchanged for an
//                      `HttpOnly; SameSite=Strict` cookie holding a SECOND, freshly minted secret
//                      ({@linkcode handshake}); the query token is single-use, so a leaked link is
//                      not a second way in, and every request without the cookie is a 401
//                      ({@linkcode authorized}). The cookie is never the launch token: a
//                      loopback cookie is shared across every port of its host, so whatever the
//                      browser sends to another local server must not be the credential the
//                      launcher printed — and the UI is served on `127.0.0.1`, not `localhost`,
//                      to keep even that secret off the name every other local server shares.
//   4. CSRF          — a mutation additionally needs `verifyOrigin` plus a token derived as
//                      HMAC-SHA256(cookieSecret, "csrf") ({@linkcode checkCsrf}).
//   5. containment   — {@linkcode uiSafeJoin} / {@linkcode uiSafeUnder} for every project path
//                      (lexical + realpath), and {@linkcode writeFileAtomic} for every write.
//   6. headers       — {@linkcode applySecurityHeaders}: strict CSP, COOP/CORP, same-origin referrer,
//                      no-store.
//
// `--read-only` refuses every mutation before any of it runs.

import { dirname, isAbsolute, relative, resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import { verifyOrigin } from "../server/origin-check.ts";

/** The cookie the session secret is parked in after the `?t=` handshake. */
export const UI_COOKIE = "denext_ui_token";

/** The header a JSON (non-form) mutation carries its CSRF token in. */
export const UI_CSRF_HEADER = "x-denext-ui-csrf";

/** The hidden form field a no-JS mutation carries its CSRF token in. */
export const UI_CSRF_FIELD = "_csrf";

/** The exact response header set every UI response carries. */
const UI_HEADERS: readonly (readonly [string, string])[] = [
  [
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  ],
  // same-origin, not no-referrer: under no-referrer a no-JS form POST carries `Origin: null`,
  // which the origin check refuses. Cross-origin requests still get no referrer.
  ["referrer-policy", "same-origin"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
  ["cache-control", "no-store"],
  ["x-content-type-options", "nosniff"],
];

/**
 * The shortest `--token` the UI accepts: 22 base64url characters, i.e. at least 128 bits of
 * entropy when the caller generated it properly. A shorter one would be a guessable local
 * credential, so the launch is refused rather than quietly weakened.
 */
export const MIN_UI_TOKEN_LENGTH = 22;

/** The credential the handshake parks in the cookie, and the CSRF token derived from it. */
export interface UiCookie {
  /** A fresh 256-bit secret (base64url), distinct from the launch token, stored in the cookie. */
  readonly secret: string;
  /** The CSRF token derived from the secret; every mutation must present this. */
  readonly csrf: string;
}

/** One launch's credentials. */
export interface UiSession {
  /** The 256-bit launch token (base64url) handed over in `?t=`; never stored in the cookie. */
  readonly token: string;
  /**
   * The cookie credential, minted by the handshake; `null` until it has run. Its presence is
   * what makes the handshake single-use: once minted, a `?t=` from a caller that does not
   * already hold this cookie is refused, so the token left behind in a shell history or an
   * `open` argv cannot be replayed into a second session.
   */
  cookie: UiCookie | null;
}

/**
 * Mint (or adopt) the launch token for one `denext ui` launch. The cookie credential is not
 * minted here: it comes into being at the handshake, for the caller that presents the token.
 *
 * @param token An explicit `--token`; a fresh 256-bit token is generated when omitted.
 * @returns The session, holding the launch token and no cookie yet.
 * @throws When an explicit token is shorter than {@linkcode MIN_UI_TOKEN_LENGTH} (a rejection,
 *   so `startUiServer` stays a promise its caller can `catch` either way).
 */
export function createUiSession(token?: string): Promise<UiSession> {
  if (token !== undefined && token.length > 0 && token.length < MIN_UI_TOKEN_LENGTH) {
    return Promise.reject(
      new Error(
        `denext: --token must be at least ${MIN_UI_TOKEN_LENGTH} characters ` +
          "(base64url, \u2265 128 bits of entropy) \u2014 omit it to have one minted for you.",
      ),
    );
  }
  const value = token && token.length > 0 ? token : newToken();
  return Promise.resolve({ token: value, cookie: null });
}

/**
 * A fresh 256-bit URL-safe token.
 *
 * @returns 43 base64url characters of `crypto.getRandomValues` entropy.
 */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The CSRF token for a session: HMAC-SHA256 of the literal `"csrf"` under the cookie secret.
 * Deriving (rather than minting a third random value) keeps the pair inseparable, so the cookie
 * is the only secret a session has to reason about — the launch token is spent at the handshake
 * and takes part in nothing after it.
 *
 * @param secret The cookie secret.
 * @returns The derived CSRF token (base64url).
 */
export async function deriveCsrf(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("csrf") as BufferSource,
  );
  return base64url(new Uint8Array(sig));
}

/** URL-safe, unpadded base64 of `bytes`. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Length-independent, constant-time string comparison (no early exit on the first differing
 * character, and unequal lengths still walk the full loop).
 *
 * @param a First value.
 * @param b Second value.
 * @returns Whether the two are identical.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

// ── layer 2: host + origin ───────────────────────────────────────────────────

/**
 * May this request reach the UI at all? The Host header must name a loopback interface (so a
 * hostname an attacker controls that resolves to 127.0.0.1 cannot be "same-origin" with the UI
 * in a browser's eyes), and a browser-supplied `Sec-Fetch-Site` must read `same-origin` — which
 * also refuses the Origin-less cross-site subresource load.
 *
 * @param request The incoming request.
 * @param url Its parsed URL.
 * @returns Whether to proceed (a `false` is a 403).
 */
export function uiOriginAllowed(request: Request, url: URL): boolean {
  if (!loopbackHost(url.hostname)) return false;
  const site = request.headers.get("sec-fetch-site");
  // `none` is a navigation the user started themselves: the printed URL handed to the browser
  // launcher, typed, or opened from a bookmark. No other site's page can produce it — a
  // page-initiated request is `same-origin`, `same-site` or `cross-site` — so it is safe to READ
  // the UI with, and it is how every browser asks for the first page. A mutation still has to
  // come from the UI's own page (`same-origin`), and passes the CSRF gate besides.
  if (site) return site === "same-origin" || (site === "none" && !isMutation(request.method));
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl / tests — no ambient-credential risk
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false; // malformed Origin
  }
}

/**
 * Whether `method` changes state, and therefore passes the read-only, origin and CSRF gates
 * that a read does not.
 *
 * @param method An HTTP method.
 * @returns Whether it is anything but a read.
 */
export function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/** Whether `hostname` (possibly a bracketed IPv6 literal) names the loopback interface. */
function loopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

// ── layer 3: the token handshake ─────────────────────────────────────────────

/**
 * The `?t=<token>` handshake: on a valid token, mint a fresh cookie secret, park it in an
 * `HttpOnly; SameSite=Strict` cookie and 302 to the **overview**, so the launch token never
 * survives in the address bar, `document.referrer`, history, or a copied link — and is never
 * what the cookie holds.
 *
 * The cookie is a second secret, not the token, because a cookie set by a loopback host is sent
 * to every port of that host: the project's own `denext dev`, or anything else listening there,
 * receives it. A cookie the launcher never printed is all such a server can learn; the launch
 * token, which is in the shell history and the browser launcher's argv, stays out of it.
 *
 * The destination is always `/` rather than whatever path the link carried. The launcher only
 * ever prints `/?t=…`, so this is where a handshake landed in practice anyway; sending it
 * anywhere else would let a copied link decide the first page, and echoing the request's own
 * path back as a `Location` is a shape worth not having at all.
 *
 * The exchange is **single-use**. Once it has run, a `?t=` is honoured only for a caller that
 * already holds the session cookie (the same tab re-opening its own link, which keeps the cookie
 * it has), so the token that is left behind in `open`'s argv, a shell history or a copied URL
 * cannot be replayed into a second session for the server's lifetime.
 *
 * @param request The incoming request (its cookie decides whether a spent token is still its own).
 * @param url The parsed request URL.
 * @param session The launch credentials (the cookie is minted by the first successful exchange).
 * @returns The redirect, the 401 for a wrong or replayed token, or `null` when there was no `?t=`.
 */
export async function handshake(
  request: Request,
  url: URL,
  session: UiSession,
): Promise<Response | null> {
  const presented = url.searchParams.get("t");
  if (presented === null) return null;
  const correct = constantTimeEqual(presented, session.token);
  if (!correct || (session.cookie !== null && authorized(request, session) === null)) {
    return new Response(JSON.stringify({ ok: false, reason: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (session.cookie === null) {
    const secret = newToken();
    session.cookie = { secret, csrf: await deriveCsrf(secret) };
  }
  // A fixed destination, so nothing from the request reaches the `Location` header: a request
  // for `//evil.example/` cannot become a protocol-relative redirect off the loopback origin,
  // because the path is not built from the URL at all.
  const headers = new Headers({ location: "/" });
  headers.append(
    "set-cookie",
    `${UI_COOKIE}=${session.cookie.secret}; HttpOnly; SameSite=Strict; Path=/`,
  );
  return new Response(null, { status: 302, headers });
}

/**
 * Is the session cookie present and correct?
 *
 * @param request The incoming request.
 * @param session The launch credentials.
 * @returns The cookie credential the caller holds, or `null` when it is absent, wrong, or not
 *   minted yet (no handshake has run).
 */
export function authorized(request: Request, session: UiSession): UiCookie | null {
  const cookie = readCookie(request.headers.get("cookie"), UI_COOKIE);
  const minted = session.cookie;
  return cookie !== null && minted !== null && constantTimeEqual(cookie, minted.secret)
    ? minted
    : null;
}

/** The value of `name` in a `Cookie` header, or `null`. */
function readCookie(header: string | null, name: string): string | null {
  const prefix = `${name}=`;
  const hit = (header ?? "").split(/;\s*/).find((part) => part.startsWith(prefix));
  return hit === undefined ? null : hit.trim().slice(prefix.length);
}

// ── layer 4: CSRF ────────────────────────────────────────────────────────────

/**
 * The CSRF gate for a mutation: a same-origin `Origin`/`Referer` (`verifyOrigin`, the same check
 * denext applies to Server Actions) plus the derived token, from the header or the hidden field.
 *
 * @param request The incoming request.
 * @param url Its parsed URL.
 * @param cookie The cookie credential the caller holds (from {@linkcode authorized}).
 * @param form The decoded form body, when the mutation carried one.
 * @returns `null` when the mutation may proceed, else the refusal reason.
 */
export function checkCsrf(
  request: Request,
  url: URL,
  cookie: UiCookie,
  form?: FormData,
): string | null {
  if (!verifyOrigin(request, { canonicalOrigin: url.origin })) return "bad origin";
  const header = request.headers.get(UI_CSRF_HEADER);
  const field = form?.get(UI_CSRF_FIELD);
  const presented = header ?? (typeof field === "string" ? field : null);
  if (presented === null || !constantTimeEqual(presented, cookie.csrf)) return "bad csrf token";
  return null;
}

// ── layer 5: containment ─────────────────────────────────────────────────────

/**
 * Join a project-relative path under `root` and refuse to escape it. Lexical first (`..`,
 * absolute paths), then a realpath re-check of the deepest existing ancestor, so a symlink
 * *inside* the project cannot point the UI at a file outside it.
 *
 * @param root The project directory.
 * @param rel The project-relative path the browser asked for.
 * @returns The absolute path, guaranteed to be inside `root`.
 * @throws When the path escapes the project (a `denext:`-prefixed error).
 */
export async function uiSafeJoin(root: string, rel: string): Promise<string> {
  if (isAbsolute(rel)) throw escapeError(rel);
  return await contained(root, resolve(resolve(root), rel), rel);
}

/**
 * The text of `root/rel`, or `null` when it does not exist, cannot be read, or is a symlink whose
 * target leaves the project.
 *
 * The containment gate is the point: every panel that shows a project file — the config editor,
 * the plugin manager, the cron tab — reads it through here, so a `denext.config.ts` symlinked at
 * `~/.aws/credentials` reaches neither the page nor the writer. A missing file is `null` rather
 * than a throw, because "the project has no config yet" is an ordinary state for these panels.
 *
 * @param root The project directory.
 * @param rel The project-relative file name.
 * @returns Its text, or `null`.
 */
export async function readContained(root: string, rel: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(await uiSafeJoin(root, rel));
  } catch {
    return null;
  }
}

/**
 * The optimistic-concurrency stamp for one file's text: its SHA-256, hex.
 *
 * Every editing form carries this as `_base`, and the write is refused when the file on disk no
 * longer matches — so an edit made in a real editor (or a second tab) is never silently lost.
 *
 * @param source The file's text (`""` when there is no file yet).
 * @returns The hex digest.
 */
export async function stampOf(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source) as BufferSource;
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * The same containment gate for a path that is **already absolute** — the paths a planner
 * (`generateArtifact`'s dry run, a Docker plan) computed for itself. A lexical check alone would
 * pass `<root>/app/x` even when `app` is a symlink out of the project, so the realpath re-check
 * is what actually decides.
 *
 * @param root The project directory.
 * @param path The absolute path to check.
 * @returns `path`, guaranteed to resolve inside `root`.
 * @throws When it escapes the project (a `denext:`-prefixed error).
 */
export async function uiSafeUnder(root: string, path: string): Promise<string> {
  return await contained(root, resolve(path), path);
}

/** Lexical containment, then a realpath re-check of the deepest existing ancestor. */
async function contained(root: string, target: string, label: string): Promise<string> {
  const base = resolve(root);
  const r = relative(base, target);
  if (r === ".." || r.startsWith(".." + "/") || r.startsWith(".." + "\\")) throw escapeError(label);
  const realBase = await Deno.realPath(base);
  if (!within(await realPathOfNearest(target), realBase)) throw escapeError(label);
  return target;
}

/** A write refused because the file changed after the caller read it (a lost update averted). */
export class StaleWriteError extends Error {
  /**
   * @param rel The project-relative path that changed.
   */
  constructor(readonly rel: string) {
    super(`${rel} changed on disk since it was read — nothing was written`);
    this.name = "StaleWriteError";
  }
}

/** Options for {@linkcode writeFileAtomic}. */
export interface WriteFileAtomicOptions {
  /**
   * The text the caller based its edit on. When the file no longer holds exactly this just
   * before the rename, nothing is written and {@linkcode StaleWriteError} is thrown.
   */
  readonly unchangedFrom?: string;
}

/**
 * Write a project file the way a crash-safe editor does: a sibling `.tmp` file, then one
 * `Deno.rename` over the target. The reader of a config or a compose file therefore never sees a
 * half-written document, and a failed write leaves the previous bytes exactly as they were.
 *
 * The path goes through {@linkcode uiSafeJoin} first, and the rename replaces a *symlink* rather
 * than following it — so an in-project link never becomes a write to whatever it points at.
 *
 * With `options.unchangedFrom`, the file is re-read just before the rename and the write is
 * refused ({@linkcode StaleWriteError}) unless it still holds exactly that text — so a change
 * made elsewhere after the caller's own stale-check (the `_base` stamp) is a refusal, not a
 * lost update. An absent file reads as `""`.
 *
 * An existing target keeps its permission bits: the temp file is created at the default mode,
 * so without this a `0600` config would come back `0644` after one edit. Skipped where there
 * is no mode to keep (a new file, Windows, an unreadable stat).
 *
 * @param root The project directory.
 * @param rel The project-relative path to write.
 * @param text The file's new contents.
 * @param options `unchangedFrom`: the text the caller based its edit on.
 * @returns The absolute path written.
 * @throws When the path escapes the project, the file changed since `unchangedFrom` was read
 * ({@linkcode StaleWriteError}), or the write itself fails.
 */
export async function writeFileAtomic(
  root: string,
  rel: string,
  text: string,
  options: WriteFileAtomicOptions = {},
): Promise<string> {
  const path = await uiSafeJoin(root, rel);
  const temp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(temp, text);
    await keepMode(path, temp);
    if (options.unchangedFrom !== undefined) {
      const current = await Deno.readTextFile(path).catch(() => "");
      if (current !== options.unchangedFrom) throw new StaleWriteError(rel);
    }
    await Deno.rename(temp, path);
  } catch (error) {
    await Deno.remove(temp).catch(() => {/* never written, or already renamed */});
    throw error;
  }
  return path;
}

/**
 * Give `temp` the permission bits `target` has, so the rename does not change them. A missing
 * target, a platform with no modes (Windows) or a failed stat leaves the temp file as created.
 */
async function keepMode(target: string, temp: string): Promise<void> {
  if (Deno.build.os === "windows") return;
  let mode: number | null;
  try {
    mode = (await Deno.stat(target)).mode;
  } catch {
    return; // a new file: nothing to keep
  }
  if (mode === null) return;
  await Deno.chmod(temp, mode & 0o7777);
}

/** The realpath of `path`, or of its nearest existing ancestor when it does not exist yet. */
async function realPathOfNearest(path: string): Promise<string> {
  let current = path;
  for (let i = 0; i < 64; i++) {
    try {
      return await Deno.realPath(current);
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) return current;
      current = parent;
    }
  }
  return current;
}

/** Whether `p` is `dir` itself or lives under it. */
function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + "/") || p.startsWith(dir + "\\");
}

/** The refusal thrown by {@linkcode uiSafeJoin}. */
function escapeError(rel: string): Error {
  return new Error(
    `denext: ui refuses to touch a path outside the project (${rel}).`,
  );
}

// ── layer 6: headers ─────────────────────────────────────────────────────────

/**
 * Stamp the UI's fixed header set onto a response (in place; the same response is returned).
 *
 * @param response The response to harden.
 * @returns The same response.
 */
export function applySecurityHeaders(response: Response): Response {
  for (const [name, value] of UI_HEADERS) response.headers.set(name, value);
  return response;
}
