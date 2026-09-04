// Signed-cookie sessions — the auth primitive a Next.js dev expects but the
// framework doesn't ship. A stateless, tamper-proof session stored in one cookie:
// the payload (your data + an expiry) is signed with HMAC-SHA256 (Web Crypto — no
// npm), so it can be read and trusted without a server-side store. Rotate secrets
// by passing an array (all verify; the first signs). Built on the ambient
// `cookies()`, so it works in Server Components, Route Handlers, actions, and
// middleware. For larger/opaque sessions, store an id here and look the record up.

import { cookies } from "./request-context.ts";

/** Options for {@linkcode getSession}. */
export interface SessionOptions {
  /**
   * HMAC signing secret. Pass an **array** to rotate: every secret verifies, the
   * first signs — so deploy the new secret first, then retire the old one. Use a
   * long random value (e.g. `crypto.randomUUID()` + more), kept out of source.
   */
  secret: string | string[];
  /** Cookie name. Default `"denext_session"`. */
  cookieName?: string;
  /**
   * Origin-lock the session cookie with the `__Host-` name prefix (RFC 6265bis).
   * The browser then binds the cookie to the exact origin: it must be `Secure`,
   * `Path=/`, and carry **no `Domain`**, and a sibling subdomain can neither read
   * nor overwrite it — closing subdomain session-fixation/shadowing. denext (via
   * the cookie layer) guarantees those attributes, so no other config is needed;
   * it works on `http://localhost` too (browsers treat localhost as secure), but a
   * non-localhost plain-HTTP origin can't store a `Secure` cookie.
   *
   * **Recommended for new apps.** Off by default because enabling it renames the
   * cookie to `__Host-<name>`, which invalidates sessions issued under the
   * unprefixed name (users are logged out once, on the upgrade). No-op if
   * `cookieName` already begins with `__Host-`.
   */
  hostPrefix?: boolean;
  /** Session lifetime in seconds. Default 7 days. */
  maxAge?: number;
  /** Cookie `SameSite`. Default `"Lax"`. */
  sameSite?: "Strict" | "Lax" | "None";
  /** Cookie `Path`. Default `"/"`. Forced to `"/"` when `hostPrefix` is set. */
  path?: string;
}

/** A request's session. `data` is the verified payload (or `null` when absent/invalid). */
export interface Session<T> {
  /** The current session data, or `null` when there is no valid session. */
  readonly data: T | null;
  /** Replace the session data and (re)issue the signed cookie. */
  set(data: T): Promise<void>;
  /** Clear the session (deletes the cookie). */
  clear(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Minimum recommended session-secret length (chars); shorter secrets warn once. */
const MIN_SECRET_LENGTH = 32;
/** Emit the weak-secret warning at most once per process (avoid per-request spam). */
let warnedWeakSecret = false;

/** Encode bytes as URL-safe base64 (no padding). Shared with the Remix session compat. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Decode URL-safe base64 (no padding) back to bytes. Shared with the Remix session compat. */
export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** HMAC-SHA256 sign `payload` with `secret`, returned URL-safe base64. */
export async function hmacSign(payload: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await keyFor(secret),
    encoder.encode(payload) as BufferSource,
  );
  return toBase64Url(new Uint8Array(sig));
}

/** Verify `payload` against `sig` for any of `secrets` (constant-time via subtle.verify). */
export async function hmacVerify(
  payload: string,
  sig: string,
  secrets: string[],
): Promise<boolean> {
  let sigBytes: BufferSource;
  try {
    sigBytes = fromBase64Url(sig) as BufferSource;
  } catch {
    return false;
  }
  const data = encoder.encode(payload) as BufferSource;
  for (const secret of secrets) {
    if (await crypto.subtle.verify("HMAC", await keyFor(secret), sigBytes, data)) return true;
  }
  return false;
}

/**
 * Read (and manage) the current request's session. The returned object exposes the
 * verified `data`, plus `set()`/`clear()`.
 *
 * @example
 * ```ts
 * const session = await getSession<{ userId: string }>({ secret: Deno.env.get("SESSION_SECRET")! });
 * if (!session.data) redirect("/login");
 * // after a successful login:
 * await session.set({ userId: user.id });
 * ```
 *
 * @param options Signing secret(s) + cookie settings.
 */
export async function getSession<T>(options: SessionOptions): Promise<Session<T>> {
  const store = cookies();
  const { name, path } = sessionCookieAttrs(options);
  const secrets = sessionSecrets(options);
  const maxAge = options.maxAge ?? 60 * 60 * 24 * 7;
  const sameSite = options.sameSite ?? "Lax";
  let current: T | null = await readSessionCookie<T>(store.get(name), secrets);
  return {
    get data() {
      return current;
    },
    async set(data: T) {
      current = data;
      const payload = toBase64Url(
        encoder.encode(JSON.stringify({ d: data, e: Date.now() + maxAge * 1000 })),
      );
      const token = `${payload}.${await hmacSign(payload, secrets[0])}`;
      // httpOnly/secure defaults come from cookies().set(); pin sameSite + maxAge.
      store.set(name, token, { maxAge, sameSite, path });
    },
    clear() {
      current = null;
      store.delete(name, { path });
    },
  };
}

/**
 * The cookie name + path. `__Host-` binds the cookie to the exact origin (Secure + Path=/
 * + no Domain); the cookie layer (@std) enforces those attributes for any `__Host-`-named
 * cookie, so opting in is just the prefix — and it requires Path=/ (a non-"/" path would
 * make the browser drop the cookie), so the path is pinned (warned in dev if the caller
 * asked for something else).
 */
function sessionCookieAttrs(options: SessionOptions): { name: string; path: string } {
  let name = options.cookieName ?? "denext_session";
  const hostPrefixed = name.startsWith("__Host-") || options.hostPrefix === true;
  if (options.hostPrefix && !name.startsWith("__Host-")) name = `__Host-${name}`;
  const wantsOtherPath = options.path !== undefined && options.path !== "/";
  if (
    hostPrefixed && wantsOtherPath && (globalThis as { __denextDev?: boolean }).__denextDev === true
  ) {
    console.warn(
      `denext: a __Host- session cookie must use Path=/ — ignoring path="${options.path}".`,
    );
  }
  return { name, path: hostPrefixed ? "/" : (options.path ?? "/") };
}

/**
 * The signing secret(s), validated. Warns (once) on a too-short secret: a short/low-entropy
 * secret is brute-forceable, letting an attacker forge session cookies — kept a warning (not
 * a throw) so upgrading the framework can't brick a live deployment.
 */
function sessionSecrets(options: SessionOptions): string[] {
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret];
  if (secrets.length === 0 || secrets.some((s) => !s)) {
    throw new Error("getSession: `secret` must be a non-empty string (or array of them).");
  }
  if (!warnedWeakSecret && secrets.some((s) => (s as string).length < MIN_SECRET_LENGTH)) {
    warnedWeakSecret = true;
    console.warn(
      `denext: session secret is shorter than ${MIN_SECRET_LENGTH} chars — use a long, ` +
        `random secret (e.g. \`openssl rand -base64 32\`) so session cookies can't be forged.`,
    );
  }
  return secrets;
}

/** The session data carried by a valid, unexpired, correctly signed cookie — else null. */
async function readSessionCookie<T>(raw: string | undefined, secrets: string[]): Promise<T | null> {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  if (!(await hmacVerify(payload, raw.slice(dot + 1), secrets))) return null;
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as { d: T; e: number };
    return typeof parsed.e === "number" && parsed.e > Date.now() ? parsed.d : null;
  } catch {
    return null; // malformed payload → treat as no session
  }
}
