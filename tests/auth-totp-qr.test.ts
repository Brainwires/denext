// `totpQrSvg`: the provisioning URI `enrollTotp` returns, rendered as an SVG QR code — read back
// out of the markup and decoded by an independent reader (jsQR, a dev-only test dependency in deno.json), at
// every error-correction level; plus the refusals (a non-otpauth URI, unsafe colours, a URI too
// long for any symbol).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import jsQRModule from "jsqr";
import { enrollTotp, inMemoryAuthAdapter, totpAuthUri, totpQrSvg } from "denext/server";
import type { AuthConfig, AuthSession } from "denext/server";

/** jsQR's CommonJS default export is the reader itself; its typings describe it as a namespace. */
const jsQR = jsQRModule as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { binaryData: number[] } | null;

/** Re-draw the SVG's `<path>` runs into RGBA pixels (`scale` px per module) and decode them. */
function decodeSvg(svg: string, scale = 4): string | null {
  const extent = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  assert(extent > 0, "a square viewBox");
  const size = extent * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  const path = /<path fill="#000" d="([^"]*)"/.exec(svg)?.[1] ?? "";
  for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < Number(w) * scale; dx++) {
        const p = ((Number(y) * scale + dy) * size + Number(x) * scale + dx) * 4;
        data[p] = data[p + 1] = data[p + 2] = 0;
      }
    }
  }
  const decoded = jsQR(data, size, size);
  return decoded ? new TextDecoder().decode(new Uint8Array(decoded.binaryData)) : null;
}

const URI = totpAuthUri({
  secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  account: "ada@example.com",
  issuer: "Acme Corp",
});

Deno.test("totpQrSvg: the SVG decodes back to the otpauth:// URI at every level", () => {
  for (const ecc of ["L", "M", "Q", "H"] as const) {
    assertEquals(decodeSvg(totpQrSvg(URI, { ecc })), URI, ecc);
  }
});

Deno.test("totpQrSvg: an enrollment's URI renders and decodes", async () => {
  const adapter = inMemoryAuthAdapter();
  const config: AuthConfig = {
    secret: "x".repeat(32),
    providers: [{ id: "c", type: "credentials", authorize: () => null }],
    adapter,
    mfa: { issuer: "denext.dev" },
  };
  const now = Math.floor(Date.now() / 1000);
  const session: AuthSession = {
    user: { id: "u1", email: "ada@example.com" },
    provider: "c",
    expiresAt: now + 3600,
    authTime: now,
  };
  const enrollment = await enrollTotp(config, session);
  assert(enrollment.ok);
  assertEquals(decodeSvg(totpQrSvg(enrollment.uri)), enrollment.uri);
});

Deno.test("totpQrSvg: defaults — level M, a 4-module quiet zone, an accessible name", () => {
  const svg = totpQrSvg(URI);
  assertStringIncludes(svg, 'role="img"');
  assertStringIncludes(svg, "<title>Authenticator app setup code</title>");
  assertStringIncludes(svg, 'fill="#fff"');
  // A 4-module margin: the first dark run (the top-left finder) starts at (4, 4).
  assertStringIncludes(svg, 'd="M4 4h7v1h-7z');
  assert(!totpQrSvg(URI, { title: "" }).includes("<title>"), '"" omits the title');
  assertStringIncludes(totpQrSvg(URI, { size: 240 }), 'width="240" height="240"');
  assert(totpQrSvg(URI, { margin: 0 }).includes('d="M0 0h7v1h-7z'));
});

Deno.test("totpQrSvg: refuses anything but an otpauth:// URI", () => {
  for (const bad of ["https://example.com", "javascript:alert(1)", "", "otpauth:/x"]) {
    assertThrows(() => totpQrSvg(bad), TypeError, "otpauth://");
  }
  assertThrows(() => totpQrSvg(undefined as unknown as string), TypeError);
  // The scheme is case-insensitive (RFC 3986 §3.1).
  assertEquals(
    decodeSvg(totpQrSvg("OTPAUTH://totp/x?secret=AAAA")),
    "OTPAUTH://totp/x?secret=AAAA",
  );
});

Deno.test("totpQrSvg: an unsafe colour or an oversized URI is refused", () => {
  assertThrows(() => totpQrSvg(URI, { color: '#000" onload="alert(1)' }), TypeError);
  assertThrows(() => totpQrSvg(URI, { background: "url(https://x)" }), TypeError);
  assertThrows(() => totpQrSvg(`otpauth://totp/x?secret=${"A".repeat(3000)}`), RangeError);
  const escaped = totpQrSvg(URI, { title: "</title><script>alert(1)</script>" });
  assert(!escaped.includes("<script"));
});
