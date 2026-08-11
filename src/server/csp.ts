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

import type { RouteCsp } from "./segment-config.ts";

export type { RouteCsp };

/** SHA-256 of `text` as base64 (the form a CSP `'sha256-…'` source expects). */
async function sha256Base64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Executable-script types (anything else — application/json islands, importmaps —
// is not gated by `script-src`).
const EXECUTABLE_SCRIPT_TYPES = new Set(["text/javascript", "module", "application/javascript"]);

/**
 * Extract the bodies of inline `<script>` (executable only — skip `src=` and
 * non-JS `type=`) and inline `<style>` elements from a rendered document. The
 * captured body is the exact text the browser hashes for CSP.
 */
export function extractInlineForCsp(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = scriptRe.exec(html); m; m = scriptRe.exec(html)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue; // external same-origin → 'self'
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !EXECUTABLE_SCRIPT_TYPES.has(type)) continue; // JSON island, importmap, …
    scripts.push(m[2]);
  }

  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m = styleRe.exec(html); m; m = styleRe.exec(html)) {
    styles.push(m[1]);
  }

  return { scripts, styles };
}

/**
 * Build the `Content-Security-Policy` header value for a rendered document:
 * `'self'` plus a `'sha256-…'` for each inline script/style it contains, plus any
 * per-route external opt-ins. External scripts/styles are otherwise blocked.
 * `style-src-attr 'unsafe-inline'` keeps React's `style={{}}` working (style
 * injection is cosmetic; script injection stays fully blocked).
 */
export async function computeCsp(html: string, route?: RouteCsp): Promise<string> {
  const { scripts, styles } = extractInlineForCsp(html);
  const scriptHashes = await Promise.all(
    scripts.map(async (s) => `'sha256-${await sha256Base64(s)}'`),
  );
  const styleHashes = await Promise.all(
    styles.map(async (s) => `'sha256-${await sha256Base64(s)}'`),
  );

  const scriptSrc = ["'self'", ...scriptHashes, ...(route?.scriptSrc ?? [])];
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
