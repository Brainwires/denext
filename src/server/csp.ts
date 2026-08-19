// Content-Security-Policy assembly for rendered HTML documents.
//
// denext's CSP is **hash-based**, not nonce-based. The ISR cache stores a
// document byte-for-byte, so a per-request nonce would be identical for every
// viewer of a cached page — and, being visible in the public HTML, useless as an
// unguessable token. A `'sha256-…'` of each inline script/style body is instead
// content-derived: stable across requests, safe to cache, and it keeps working
// after a cache hit. Most pages carry NO inline executable script (the data
// islands are `type="application/json"`, non-executable; the runtime entry is a
// same-origin `<script src>` covered by `'self'`), so their CSP needs no hashes.
//
// The policy blocks external scripts/styles by default; a route opts specific
// hosts in via its `csp` segment-config export.
//
// SEC-L1 — scope: `computeCsp` runs on the fully BUFFERED document (the whole HTML
// string is in hand, so inline <style> bodies can be hashed). The STREAMING HTML
// and Flight paths emit bytes before the document is complete, so they do NOT get a
// content-derived style-hash CSP from here — apply a CSP at your edge/proxy for
// streamed responses if you rely on one. Script sources are unaffected: `script-src`
// is always exactly `'self'` (+ route opt-ins), never a per-output hash, so the
// streaming paths are as constrained as the buffered one for scripts.

import type { CspSetting, RouteCsp } from "./segment-config.ts";

export type { CspSetting, RouteCsp };

/** SHA-256 of `text` as base64 (the form a CSP `'sha256-…'` source expects). */
async function sha256Base64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Extract the bodies of inline `<style>` elements from a rendered document (the
 * exact text the browser hashes for CSP).
 *
 * Inline `<script>` bodies are deliberately NOT hashed: denext emits no executable
 * inline script of its own on the buffered document path (its data islands are
 * `type="application/json"` and its runtime entry is a same-origin `<script src>`,
 * both covered by `script-src 'self'`). The only inline scripts in the output are
 * app-authored `<Script>` bodies — and hashing whatever appears in the output would
 * let an injected `<script>` (via dangerouslySetInnerHTML) mint its own hash and
 * self-authorize, gutting the CSP's XSS defense. Author inline scripts must instead
 * use an external `src` or a per-route `csp.scriptSrc` opt-in.
 */
export function extractInlineForCsp(html: string): { styles: string[] } {
  const styles: string[] = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m = styleRe.exec(html); m; m = styleRe.exec(html)) {
    styles.push(m[1]);
  }
  return { styles };
}

/**
 * Build the `Content-Security-Policy` header value for a rendered document:
 * `script-src 'self'` (denext ships no executable inline scripts of its own),
 * `style-src 'self'` plus a `'sha256-…'` for each inline `<style>`, plus any
 * per-route external opt-ins. External scripts/styles are otherwise blocked.
 * `style-src-attr 'unsafe-inline'` keeps React's `style={{}}` working (style
 * injection is cosmetic; script injection stays fully blocked).
 */
export async function computeCsp(html: string, route?: RouteCsp): Promise<string> {
  const { styles } = extractInlineForCsp(html);
  const styleHashes = await Promise.all(
    styles.map(async (s) => `'sha256-${await sha256Base64(s)}'`),
  );

  const scriptSrc = ["'self'", ...(route?.scriptSrc ?? [])];
  const styleSrc = ["'self'", ...styleHashes, ...(route?.styleSrc ?? [])];
  const imgSrc = ["'self'", "data:", ...(route?.imgSrc ?? [])];
  const connectSrc = ["'self'", ...(route?.connectSrc ?? [])];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    "style-src-attr 'unsafe-inline'",
    `img-src ${imgSrc.join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Resolve the effective CSP header value for a buffered document from the
 * three-state settings. The per-route setting (from the route's `csp` export) wins
 * when present; otherwise the app-wide default (`denext.config` `csp`) applies;
 * absent both, the default is `"strict"`.
 *
 * @param html The fully buffered document.
 * @param routeCsp The route's resolved {@link CspSetting} (may be undefined).
 * @param globalCsp The app-wide default {@link CspSetting} (may be undefined).
 * @returns The `Content-Security-Policy` value, or `undefined` to emit no header.
 */
export async function resolveCsp(
  html: string,
  routeCsp: CspSetting | undefined,
  globalCsp: CspSetting | undefined,
): Promise<string | undefined> {
  const effective = routeCsp ?? globalCsp ?? "strict";
  if (effective === "off") return undefined;
  if (effective === "strict") return await computeCsp(html);
  return await computeCsp(html, effective);
}

/**
 * True when the effective CSP for a route is `"off"` (no header would be emitted).
 * The route setting wins over the global; the global defaults to `"strict"`. Used
 * to gate incremental streaming — a streamed response can't carry the hash-CSP, so
 * it's only allowed where no CSP applies.
 */
export function cspIsOff(
  routeCsp: CspSetting | undefined,
  globalCsp: CspSetting | undefined,
): boolean {
  return (routeCsp ?? globalCsp ?? "strict") === "off";
}
