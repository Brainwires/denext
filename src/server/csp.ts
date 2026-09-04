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
// string is in hand, so inline <style> bodies can be hashed). The STREAMING HTML and
// PPR paths flush bytes before the document is complete, but they still carry the
// same strict hash-based CSP: `resolveStreamingCsp` computes it from the buffered
// shell prefix (head + shell, which holds every framework inline `<style>`) and adds
// one fixed `'sha256-…'` for the {@link swapRuntimeHash} constant — the sole inline
// `<script>` a streamed response emits. Script sources stay constrained exactly as on
// the buffered path: `script-src` is `'self'` + route opt-ins + that one constant
// hash, never a per-output hash of streamed content.

import type { CspSetting, RouteCsp } from "./segment-config.ts";
import { swapRuntimeHash } from "./swap-runtime.ts";

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
function extractInlineForCsp(html: string): { styles: string[] } {
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
/**
 * Assemble the CSP header value from the four resolved source lists. Shared by the
 * buffered ({@linkcode computeCsp}) and streaming ({@linkcode computeStreamingCsp})
 * paths so the two policies stay byte-identical apart from their script/style hashes.
 */
function assembleCsp(
  scriptSrc: string[],
  styleSrc: string[],
  imgSrc: string[],
  connectSrc: string[],
): string {
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

export async function computeCsp(html: string, route?: RouteCsp): Promise<string> {
  const { styles } = extractInlineForCsp(html);
  const styleHashes = await Promise.all(
    styles.map(async (s) => `'sha256-${await sha256Base64(s)}'`),
  );

  return assembleCsp(
    ["'self'", ...(route?.scriptSrc ?? [])],
    ["'self'", ...styleHashes, ...(route?.styleSrc ?? [])],
    ["'self'", "data:", ...(route?.imgSrc ?? [])],
    ["'self'", ...(route?.connectSrc ?? [])],
  );
}

/**
 * Build the CSP for a STREAMING document from its buffered shell prefix (the
 * `<head>` + shell HTML flushed before any hole streams). Identical to
 * {@linkcode computeCsp} except `script-src` also carries the fixed
 * {@linkcode swapRuntimeHash} — the one inline `<script>` a streamed response emits.
 *
 * The shell prefix holds every framework inline `<style>` (font CSS hoists into the
 * head, buffered before flush), so its style hashes are complete. Suspense/PPR holes
 * must not introduce inline `<style>`/`<script>` of their own — the drainers assert
 * this in dev — so nothing streamed after the prefix needs an additional hash.
 */
export async function computeStreamingCsp(
  shellHtml: string,
  route?: RouteCsp,
): Promise<string> {
  const { styles } = extractInlineForCsp(shellHtml);
  const styleHashes = await Promise.all(
    styles.map(async (s) => `'sha256-${await sha256Base64(s)}'`),
  );

  return assembleCsp(
    ["'self'", await swapRuntimeHash(), ...(route?.scriptSrc ?? [])],
    ["'self'", ...styleHashes, ...(route?.styleSrc ?? [])],
    ["'self'", "data:", ...(route?.imgSrc ?? [])],
    ["'self'", ...(route?.connectSrc ?? [])],
  );
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
 * Resolve the effective CSP for a STREAMING response from its buffered shell prefix,
 * using the same three-state settings as {@linkcode resolveCsp}. The route setting
 * wins over the app-wide default; absent both, the default is `"strict"`. Returns
 * `undefined` (emit no header) only when the effective setting is `"off"` — otherwise
 * a streamed response now carries the same strict hash-based CSP as a buffered one
 * (see {@linkcode computeStreamingCsp}).
 *
 * @param shellHtml The buffered shell prefix (head + shell) flushed before any hole.
 * @param routeCsp The route's resolved {@link CspSetting} (may be undefined).
 * @param globalCsp The app-wide default {@link CspSetting} (may be undefined).
 */
export async function resolveStreamingCsp(
  shellHtml: string,
  routeCsp: CspSetting | undefined,
  globalCsp: CspSetting | undefined,
): Promise<string | undefined> {
  const effective = routeCsp ?? globalCsp ?? "strict";
  if (effective === "off") return undefined;
  if (effective === "strict") return await computeStreamingCsp(shellHtml);
  return await computeStreamingCsp(shellHtml, effective);
}
