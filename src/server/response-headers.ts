// Response-header helpers shared by the request pipeline and the prod/SPA servers:
// HTML document headers, the default hardening headers (+ HSTS), the request-queued
// outgoing headers (cookies().set(), loader/action headers), and the bare 404.

import type { HstsConfig } from "./config.ts";

/** Headers for an HTML document response: content-type + optional CSP + extras. */
export function htmlHeaders(
  csp?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  };
  if (csp) headers["content-security-policy"] = csp;
  // L9: a page URL yields full HTML to a hard request but a Flight/soft variant to
  // a soft nav (x-denext-nav). Key any intermediary cache on that header so a
  // cached hard-nav document is never served to a soft nav (belt-and-suspenders).
  headers["vary"] = "x-denext-nav";
  return extra ? { ...headers, ...extra } : headers;
}

/**
 * Build the `Strict-Transport-Security` header value from {@link HstsConfig}
 * (`false` ⇒ omit the header). Default: `max-age=31536000` (host-only). Adds
 * `includeSubDomains`/`preload` only when configured (`preload` implies
 * `includeSubDomains`, per the preload-list rules).
 */
export function hstsHeaderValue(hsts?: HstsConfig | false): string | null {
  if (hsts === false) return null;
  const maxAge = hsts?.maxAge ?? 31536000;
  let value = `max-age=${maxAge}`;
  if (hsts?.includeSubDomains || hsts?.preload) value += "; includeSubDomains";
  if (hsts?.preload) value += "; preload";
  return value;
}

/**
 * Add opinionated hardening headers to a response, but never override one the app
 * already set (via `headers()` or middleware). `X-Content-Type-Options`,
 * `X-Frame-Options`, and `Referrer-Policy` are always applied; HSTS only when the
 * request arrived over HTTPS (harmless, but avoids pinning a plain-HTTP dev host)
 * and not disabled via `hsts: false`.
 *
 * @param hsts Optional HSTS tuning (from `denext.config`); omitted ⇒ the default policy.
 */
export function applyDefaultSecurityHeaders(
  res: Response,
  secure: boolean,
  hsts?: HstsConfig | false,
): Response {
  const defaults: Array<[string, string]> = [
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "SAMEORIGIN"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
  ];
  const hstsValue = secure ? hstsHeaderValue(hsts) : null;
  if (hstsValue) defaults.push(["strict-transport-security", hstsValue]);
  try {
    // Fast path: mutate in place when the Headers object is mutable.
    for (const [name, value] of defaults) {
      if (!res.headers.has(name)) res.headers.set(name, value);
    }
    return res;
  } catch {
    // Immutable headers (e.g. a Response.redirect() from a route handler): rebuild.
    const headers = new Headers(res.headers);
    for (const [name, value] of defaults) {
      if (!headers.has(name)) headers.set(name, value);
    }
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

/**
 * Apply a request's queued outgoing headers and an optional status override onto a
 * response. Set-Cookie headers are appended (preserving multiples via `getSetCookie`);
 * other outgoing headers (e.g. a loader/action's `data(value, { headers })`) are set;
 * `statusOverride` (e.g. `data(value, { status })`) replaces the response status. Returns
 * the response untouched when there is nothing to apply (the normal render path).
 */
export function applyOutgoing(res: Response, outgoing: Headers, statusOverride?: number): Response {
  const setCookies = outgoing.getSetCookie();
  const extra = [...outgoing].filter(([k]) => k.toLowerCase() !== "set-cookie");
  const overrides = statusOverride !== undefined && statusOverride !== res.status;
  if (setCookies.length === 0 && extra.length === 0 && !overrides) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of extra) headers.set(k, v);
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(res.body, {
    status: statusOverride ?? res.status,
    statusText: res.statusText,
    headers,
  });
}

export function notFound(pathname: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>404 — Not Found</title></head><body><h1>404 — Not Found</h1><p>No route matches <code>${
      pathname.replace(/[<>&]/g, "")
    }</code>.</p></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
