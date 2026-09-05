// Preview Mode for the Pages Router (Next's `res.setPreviewData` / `context.preview`).
//
// A CMS "preview" link calls `res.setPreviewData(data)` in an API route; that sets a
// SIGNED, httpOnly cookie. On a subsequent page request, `getStaticProps`/
// `getServerSideProps` see `context.preview === true` and `context.previewData`, and
// the handler bypasses the static/prerendered cache so drafts render live.
//
// SECURITY: the cookie is HMAC-SHA256 signed so a client cannot forge preview mode
// (which would disclose unpublished content). The signing secret comes from
// `DENEXT_PREVIEW_SECRET`; without it a random per-process key is used (preview works
// within one process but not across restarts/instances) and a one-time warning fires.

import { fromBase64Url, hmacSign, hmacVerify, toBase64Url } from "@denext/denext/plugin-kit";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The preview cookie name (httpOnly; not `__Host-` so it works under a basePath). */
const PREVIEW_COOKIE = "__denext_preview";

/** The MAC domain of preview tokens — distinct from denext's session cookie and Remix sessions. */
const PREVIEW_MAC_DOMAIN = "denext.pages-router.preview.v1";

/** Sign preview `data` into a `payload.sig` token (HMAC-SHA256, base64url). */
export async function signPreview(
  data: unknown,
  secret: string,
): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ d: data })));
  return `${payload}.${await hmacSign(payload, secret, PREVIEW_MAC_DOMAIN)}`;
}

/**
 * Verify a preview token against any of `secrets` and return its data, or `null` if
 * the token is missing, malformed, or unsigned by a known secret. `undefined` data
 * (the common `setPreviewData({})`/flag case) resolves to `{}` so the caller can
 * still distinguish "preview on" via a non-null return.
 */
export async function readPreview(
  token: string | undefined,
  secrets: string[],
): Promise<unknown | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!(await hmacVerify(payload, token.slice(dot + 1), secrets, PREVIEW_MAC_DOMAIN))) return null;
  try {
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as {
      d?: unknown;
    };
    return parsed.d ?? {};
  } catch {
    return null;
  }
}

/** Read the raw preview cookie value from a `Cookie` header. */
export function previewCookieFrom(
  cookieHeader: string | null,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === PREVIEW_COOKIE) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** Build the `Set-Cookie` value that enables preview mode (httpOnly, signed token). */
export function setPreviewCookie(
  token: string,
  opts: { secure: boolean; maxAge?: number },
): string {
  const parts = [
    `${PREVIEW_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build the `Set-Cookie` value that clears preview mode. */
export function clearPreviewCookie(secure: boolean): string {
  const parts = [
    `${PREVIEW_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

let processSecret: string | undefined;
let warnedNoSecret = false;

/**
 * Resolve the preview signing secret(s): `DENEXT_PREVIEW_SECRET` (comma-separated to
 * rotate) if set, else a stable per-process random key (with a one-time warning that
 * preview won't survive a restart or span instances without a configured secret).
 */
export function previewSecrets(): string[] {
  const env = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } })
    .Deno?.env
    ?.get("DENEXT_PREVIEW_SECRET");
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  if (!processSecret) {
    processSecret = crypto.randomUUID() + crypto.randomUUID();
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn(
        "denext/pages-router: DENEXT_PREVIEW_SECRET is not set — Preview Mode uses a " +
          "random per-process key, so preview sessions won't survive a restart or work " +
          "across instances. Set DENEXT_PREVIEW_SECRET to a long random value in production.",
      );
    }
  }
  return [processSecret];
}
