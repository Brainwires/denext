/**
 * `next-auth/jwt` on denext: the `JWT` type an app augments, {@linkcode getToken} (the
 * decoded token of the request's session), and {@linkcode encode} / {@linkcode decode}.
 *
 * The token is the one the app's `callbacks.jwt` shapes. denext keeps it **encrypted**
 * (AES-256-GCM, its key derived from `AUTH_SECRET` by HKDF-SHA256) inside its signed session
 * cookie, so a provider access token the callback stores is as unreadable to the browser as
 * in Auth.js. The wire format is denext's own, not an Auth.js JWE: a token minted by one is
 * not read by the other.
 *
 * ```ts
 * import { getToken } from "next-auth/jwt";
 * export async function GET(req: Request) {
 *   const token = await getToken({ req });
 *   return Response.json({ sub: token?.sub ?? null });
 * }
 * ```
 *
 * @module
 */

import {
  createRequestContext,
  currentContext,
  runWithContext,
} from "../../server/request-context.ts";
import { fromBase64Url, toBase64Url } from "../../server/session.ts";
import { activeNextAuth } from "./state.ts";
import { sealedSessionToken } from "./token.ts";

/**
 * The token `callbacks.jwt` receives and returns. Augment it to type your own claims:
 * `declare module "next-auth/jwt" { interface JWT { role?: string } }`.
 */
export interface JWT extends Record<string, unknown> {
  /** The user's display name. */
  name?: string | null;
  /** The user's email. */
  email?: string | null;
  /** The user's avatar URL. */
  picture?: string | null;
  /** The user id. */
  sub?: string;
  /** Issued at, epoch seconds. */
  iat?: number;
  /** Expiry, epoch seconds. */
  exp?: number;
  /** A unique token id. */
  jti?: string;
}

/** Options for {@linkcode encode}. */
export interface JWTEncodeParams<Payload = JWT> {
  /** The claims to seal. */
  token?: Payload;
  /** The secret (or rotation list, newest first) the key is derived from. */
  secret: string | string[];
  /** Separates keys per use; Auth.js passes the cookie name. Default `"authjs.session-token"`. */
  salt?: string;
  /** Seconds until the token expires. Default 30 days. */
  maxAge?: number;
}

/** Options for {@linkcode decode}. */
export interface JWTDecodeParams {
  /** The sealed token, or nothing. */
  token?: string;
  /** The secret (or rotation list) it may have been sealed under. */
  secret: string | string[];
  /** The salt it was sealed with. Default `"authjs.session-token"`. */
  salt?: string;
}

/** Options for {@linkcode getToken}. */
export interface GetTokenParams {
  /** The request whose session to read (a route handler's or middleware's). */
  req?: Request | { headers: Headers | Record<string, string> };
  /** Answer the sealed token string instead of its claims. */
  raw?: boolean;
  /** Accepted for Auth.js compatibility; the active `NextAuth()` config's secret is used. */
  secret?: string | string[];
  /** Accepted for Auth.js compatibility (denext's session cookie name is fixed). */
  cookieName?: string;
  /** Accepted for Auth.js compatibility. */
  secureCookie?: boolean;
  /** Accepted for Auth.js compatibility. */
  salt?: string;
}

/** The default salt — Auth.js's session cookie name, so a key is never shared across uses. */
const DEFAULT_SALT = "authjs.session-token";
/** Auth.js's default token lifetime: 30 days. */
const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60;
/** The format marker every sealed token starts with. */
const PREFIX = "dnx1.";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The AES-GCM key one secret and salt derive. */
async function sealingKey(secret: string, salt: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      info: encoder.encode("denext next-auth token v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The secrets to try, newest first; the first one seals. */
function secretList(secret: string | string[]): string[] {
  const list = (Array.isArray(secret) ? secret : [secret]).filter((s) => !!s);
  if (list.length === 0) throw new Error("next-auth/jwt: a secret is required");
  return list;
}

/**
 * Seal `token` (adding `iat` and `exp`) under the first secret.
 *
 * @param params The claims, the secret, the salt and the lifetime.
 * @returns The sealed token.
 */
export async function encode<Payload = JWT>(params: JWTEncodeParams<Payload>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...(params.token ?? {}),
    iat: now,
    exp: now + (params.maxAge ?? DEFAULT_MAX_AGE),
  };
  const key = await sealingKey(secretList(params.secret)[0], params.salt ?? DEFAULT_SALT);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(JSON.stringify(claims)),
    ),
  );
  return `${PREFIX}${toBase64Url(iv)}.${toBase64Url(sealed)}`;
}

/** The claims one secret opens `token` to, or `null`. */
async function openWith(
  secret: string,
  salt: string,
  iv: Uint8Array,
  sealed: Uint8Array,
): Promise<JWT | null> {
  try {
    const key = await sealingKey(secret, salt);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer> },
      key,
      sealed as Uint8Array<ArrayBuffer>,
    );
    const claims = JSON.parse(decoder.decode(plain));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Open a token {@linkcode encode} sealed — under any of the listed secrets — or `null` when it
 * is absent, malformed, tampered with, sealed under another secret or salt, or expired.
 *
 * @param params The token, the secret(s) and the salt.
 * @returns The claims, or `null`.
 */
export async function decode<Payload = JWT>(params: JWTDecodeParams): Promise<Payload | null> {
  const token = params.token;
  if (!token || !token.startsWith(PREFIX)) return null;
  const [ivPart, sealedPart] = token.slice(PREFIX.length).split(".");
  if (!ivPart || !sealedPart) return null;
  let iv: Uint8Array;
  let sealed: Uint8Array;
  try {
    iv = fromBase64Url(ivPart);
    sealed = fromBase64Url(sealedPart);
  } catch {
    return null;
  }
  for (const secret of secretList(params.secret)) {
    const claims = await openWith(secret, params.salt ?? DEFAULT_SALT, iv, sealed);
    if (!claims) continue;
    if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
    return claims as Payload;
  }
  return null;
}

/**
 * The decoded token of the request's session (JWT strategy), or `null` when signed out. Call it
 * from a route handler, middleware or a Server Action; given `req` outside a request context, it
 * reads that request's cookie.
 *
 * @param params The request, and `raw` for the sealed string.
 * @returns The claims (or the sealed string with `raw`), or `null`.
 */
export function getToken(params: GetTokenParams & { raw: true }): Promise<string | null>;
/**
 * The decoded token of the request's session, or `null`.
 *
 * @param params The request.
 * @returns The claims, or `null`.
 */
export function getToken(params?: GetTokenParams): Promise<JWT | null>;
export async function getToken(params: GetTokenParams = {}): Promise<JWT | string | null> {
  const read = async () => {
    const active = activeNextAuth();
    const sealed = await sealedSessionToken(active);
    if (!sealed || params.raw) return sealed;
    return active ? await decode({ token: sealed, secret: active.secret }) : null;
  };
  if (currentContext() || !(params.req instanceof Request)) return await read();
  return await runWithContext(createRequestContext(params.req), read);
}
