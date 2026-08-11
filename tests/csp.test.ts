// The hash-based Content-Security-Policy builder: 'self' + a sha256 for each
// inline script/style, external blocked by default, per-route opt-ins appended.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { computeCsp, extractInlineForCsp } from "../src/server/csp.ts";

/** Independent sha256-base64 to assert the builder's hashes match the content. */
async function sha256Base64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

Deno.test("a plain document gets a strict, hash-free policy", async () => {
  const csp = await computeCsp("<!DOCTYPE html><html><body><h1>hi</h1></body></html>");
  assertStringIncludes(csp, "default-src 'self'");
  assertStringIncludes(csp, "script-src 'self'");
  assertStringIncludes(csp, "style-src 'self'");
  assertStringIncludes(csp, "style-src-attr 'unsafe-inline'");
  assertStringIncludes(csp, "img-src 'self' data:");
  assertStringIncludes(csp, "object-src 'none'");
  assertStringIncludes(csp, "base-uri 'self'");
  assertStringIncludes(csp, "frame-ancestors 'self'");
  assertStringIncludes(csp, "form-action 'self'");
  assert(!csp.includes("sha256-"), "no inline content → no hashes");
  assert(!csp.includes("unsafe-inline'; script"), "script-src never gets unsafe-inline");
});

Deno.test("an inline script is hashed into script-src", async () => {
  const body = "console.log(1)";
  const csp = await computeCsp(`<html><body><script>${body}</script></body></html>`);
  assertStringIncludes(csp, `script-src 'self' 'sha256-${await sha256Base64(body)}'`);
});

Deno.test("JSON islands and external scripts are NOT hashed (not script-src gated)", async () => {
  const html = `<html><body>` +
    `<script id="__denext_data" type="application/json">{"a":1}</script>` +
    `<script type="module" src="/_denext/entry.js"></script>` +
    `</body></html>`;
  const { scripts } = extractInlineForCsp(html);
  assertEquals(scripts.length, 0);
  const csp = await computeCsp(html);
  assertEquals(csp.includes("sha256-"), false);
});

Deno.test("an inline style is hashed into style-src", async () => {
  const css = "@font-face{font-family:x;src:url(/f.woff2)}";
  const csp = await computeCsp(`<html><head><style data-denext-fonts>${css}</style></head></html>`);
  assertStringIncludes(csp, `style-src 'self' 'sha256-${await sha256Base64(css)}'`);
});

Deno.test("per-route opt-ins append external sources", async () => {
  const csp = await computeCsp("<html></html>", {
    scriptSrc: ["https://plausible.io"],
    styleSrc: ["https://fonts.googleapis.com"],
    imgSrc: ["https://cdn.example"],
    connectSrc: ["https://api.example"],
  });
  assertStringIncludes(csp, "script-src 'self' https://plausible.io");
  assertStringIncludes(csp, "style-src 'self' https://fonts.googleapis.com");
  assertStringIncludes(csp, "img-src 'self' data: https://cdn.example");
  assertStringIncludes(csp, "connect-src 'self' https://api.example");
});
