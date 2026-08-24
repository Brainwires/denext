// The Content-Security-Policy builder: script-src 'self' (inline scripts never
// hashed), style-src 'self' + a sha256 per inline <style>, external blocked by
// default, per-route opt-ins appended.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  computeCsp,
  computeStreamingCsp,
  resolveCsp,
  resolveStreamingCsp,
} from "../src/server/csp.ts";
import { swapRuntimeHash } from "../src/server/swap-runtime.ts";

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

Deno.test("inline scripts are NOT hashed — script-src stays 'self' (no self-authorization)", async () => {
  // An injected inline <script> (e.g. via dangerouslySetInnerHTML) must NOT be able
  // to mint its own hash. script-src is always exactly 'self' (+ route opt-ins).
  const html = `<html><body><script>console.log(1)</script>` +
    `<script>/*injected*/alert(document.cookie)</script></body></html>`;
  const csp = await computeCsp(html);
  assertStringIncludes(csp, "script-src 'self';");
  assertEquals(csp.includes("sha256-"), false, "no script hashes minted from output");
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

// ---- resolveCsp: three-state (strict / off / opt-ins), route over global -------

Deno.test("resolveCsp: default (both unset) is strict", async () => {
  const csp = await resolveCsp("<html></html>", undefined, undefined);
  assert(csp);
  assertStringIncludes(csp!, "script-src 'self'");
});

Deno.test("resolveCsp: global 'off' emits no header", async () => {
  assertEquals(await resolveCsp("<html></html>", undefined, "off"), undefined);
});

Deno.test("resolveCsp: route setting wins over the global", async () => {
  // Route 'off' beats global strict.
  assertEquals(await resolveCsp("<html></html>", "off", "strict"), undefined);
  // Route 'strict' beats global 'off'.
  assert(await resolveCsp("<html></html>", "strict", "off"));
  // Route opt-in object beats global 'off' (and re-enables).
  const csp = await resolveCsp("<html></html>", { scriptSrc: ["https://x.io"] }, "off");
  assertStringIncludes(csp!, "script-src 'self' https://x.io");
});

Deno.test("resolveCsp: a global opt-in object applies when the route is unset", async () => {
  const csp = await resolveCsp("<html></html>", undefined, { connectSrc: ["https://api.x"] });
  assertStringIncludes(csp!, "connect-src 'self' https://api.x");
});

// ---- streaming CSP: same strict policy + the one swap-runtime hash --------------

Deno.test("computeStreamingCsp: script-src carries the swap runtime hash", async () => {
  const csp = await computeStreamingCsp("<div><h1>shell</h1></div>");
  // 'self' + exactly the swap runtime's constant hash — no other script hashes.
  assertStringIncludes(csp, `script-src 'self' ${await swapRuntimeHash()}`);
  // Everything else matches the buffered policy.
  assertStringIncludes(csp, "object-src 'none'");
  assertStringIncludes(csp, "style-src-attr 'unsafe-inline'");
});

Deno.test("computeStreamingCsp: hashes inline <style> in the shell prefix, not in holes", async () => {
  const css = "@font-face{font-family:x;src:url(/f.woff2)}";
  // The style is in the buffered shell prefix → hashed. A style that would only
  // appear inside a streamed hole is NOT part of the prefix and so not covered here.
  const csp = await computeStreamingCsp(`<head><style>${css}</style></head><div>shell</div>`);
  assertStringIncludes(csp, `style-src 'self' 'sha256-${await sha256Base64(css)}'`);
});

Deno.test("resolveStreamingCsp: strict by default, off suppresses, route wins", async () => {
  // Default (both unset) → strict streaming CSP with the swap hash.
  const def = await resolveStreamingCsp("<div>shell</div>", undefined, undefined);
  assert(def);
  assertStringIncludes(def!, `script-src 'self' ${await swapRuntimeHash()}`);
  // 'off' emits no header (route or global).
  assertEquals(await resolveStreamingCsp("<div/>", "off", "strict"), undefined);
  assertEquals(await resolveStreamingCsp("<div/>", undefined, "off"), undefined);
  // Route opt-in object beats a global 'off' and still includes the swap hash.
  const opt = await resolveStreamingCsp("<div/>", { scriptSrc: ["https://x.io"] }, "off");
  assertStringIncludes(opt!, `script-src 'self' ${await swapRuntimeHash()} https://x.io`);
});
