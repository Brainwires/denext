// The QR encoder behind `totpQrSvg` and `denext dev --lan` (ISO/IEC 18004:2015, byte mode, every
// error-correction level, versions 1–40): module-for-module against reference symbols built by
// two independent encoders (tests/fixtures/qr-reference.ts), a decode round trip through jsQR
// (a dev-only test dependency — nothing at runtime), and the refusals.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import jsQRModule from "jsqr";
import { encodeQr, type QrEcc, type QrMatrix, renderQrSvg } from "../src/utils/qr-code.ts";
import { QR_REFERENCES } from "./fixtures/qr-reference.ts";

/** jsQR's CommonJS default export is the reader itself; its typings describe it as a namespace. */
const jsQR = jsQRModule as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { binaryData: number[] } | null;

/** Unpack a fixture's row-major, MSB-first bit string into a matrix of `size`. */
function unpack(packed: string, size: number): QrMatrix {
  const bytes = decodeBase64(packed);
  return Array.from(
    { length: size },
    (_, y) =>
      Array.from({ length: size }, (_, x) => {
        const i = y * size + x;
        return ((bytes[i >> 3] >> (7 - (i & 7))) & 1) === 1;
      }),
  );
}

/** A matrix as one string per row, so a mismatch shows where. */
function rows(m: QrMatrix): string[] {
  return m.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));
}

/** Read the mask number back out of the first format-information copy (§7.9.1). */
function maskOf(m: QrMatrix): number {
  const cells: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7]];
  const low = cells.reduce((acc, [x, y], i) => acc | ((m[y][x] ? 1 : 0) << i), 0);
  const bits = low | ((m[8][8] ? 1 : 0) << 7) | ((m[8][7] ? 1 : 0) << 8) |
    [5, 4, 3, 2, 1, 0].reduce((acc, x, k) => acc | ((m[8][x] ? 1 : 0) << (9 + k)), 0);
  return ((bits ^ 0x5412) >>> 10) & 7;
}

for (const ref of QR_REFERENCES) {
  const label = `${ref.ecc}, ${ref.text.length} chars` +
    (ref.version ? `, version ${ref.version}` : "") +
    (ref.mask !== null ? `, mask ${ref.mask}` : "");
  Deno.test(`QR reference: ${label} matches module for module`, () => {
    const m = encodeQr(ref.text, {
      ecc: ref.ecc,
      version: ref.version ?? undefined,
      mask: ref.mask ?? undefined,
    });
    assertEquals(m.length, ref.expectVersion * 4 + 17, "version");
    assertEquals(maskOf(m), ref.expectMask, "mask");
    assertEquals(rows(m), rows(unpack(ref.modules, m.length)));
  });
}

Deno.test("QR reference set covers every level, both version-info sizes and the mask search", () => {
  assertEquals(new Set(QR_REFERENCES.map((r) => r.ecc)), new Set(["L", "M", "Q", "H"]));
  assert(QR_REFERENCES.some((r) => r.expectVersion >= 7), "version information (v7+)");
  assert(QR_REFERENCES.some((r) => r.expectVersion === 32), "version 32's irregular alignment");
  assert(QR_REFERENCES.some((r) => r.expectVersion === 40), "the largest symbol");
  assertEquals(new Set(QR_REFERENCES.map((r) => r.expectMask)).size, 8, "every mask");
  assert(QR_REFERENCES.filter((r) => r.mask === null).length >= 10, "automatic mask choices");
});

/** Rasterise a matrix (4-module quiet zone, `scale` px per module) to RGBA for jsQR. */
function raster(m: QrMatrix, scale = 4): { data: Uint8ClampedArray; size: number } {
  const quiet = 4;
  const size = (m.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (!m[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
        }
      }
    }
  }
  return { data, size };
}

Deno.test("QR: symbols decode through an independent reader (jsQR) at every level", () => {
  const texts = [
    "otpauth://totp/Acme:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30",
    "Grüße — 漢字",
    "x".repeat(300),
  ];
  for (const ecc of ["L", "M", "Q", "H"] as QrEcc[]) {
    for (const text of texts) {
      const m = encodeQr(text, { ecc });
      const { data, size } = raster(m);
      const decoded = jsQR(data, size, size);
      assert(decoded, `jsQR read ${ecc} / ${text.slice(0, 12)}`);
      assertEquals(new Uint8Array(decoded.binaryData), new TextEncoder().encode(text));
    }
  }
});

Deno.test("QR: a higher level costs a larger version for the same text", () => {
  const text = "otpauth://totp/Acme:ada%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const sizes = (["L", "M", "Q", "H"] as QrEcc[]).map((ecc) => encodeQr(text, { ecc }).length);
  for (let i = 1; i < sizes.length; i++) assert(sizes[i] >= sizes[i - 1]);
  assert(sizes[3] > sizes[0]);
});

Deno.test("QR: capacity limits and bad options are RangeErrors", () => {
  // Byte-mode capacity of version 40 (ISO/IEC 18004 Table 7): L 2953, M 2331, Q 1663, H 1273.
  assertEquals(encodeQr("a".repeat(2953), { ecc: "L" }).length, 177);
  assertThrows(() => encodeQr("a".repeat(2954), { ecc: "L" }), RangeError, "too long");
  assertThrows(() => encodeQr("a".repeat(2332)), RangeError, "too long");
  assertThrows(() => encodeQr("a".repeat(1664), { ecc: "Q" }), RangeError);
  assertThrows(() => encodeQr("a".repeat(1274), { ecc: "H" }), RangeError);
  assertThrows(() => encodeQr("a".repeat(15), { version: 1 }), RangeError, "do not fit");
  assertThrows(() => encodeQr("a", { version: 0 }), RangeError);
  assertThrows(() => encodeQr("a", { version: 41 }), RangeError);
  assertThrows(() => encodeQr("a", { version: 2.5 }), RangeError);
  assertThrows(() => encodeQr("a", { mask: 8 }), RangeError);
  assertThrows(() => encodeQr("a", { mask: -1 }), RangeError);
  assertThrows(() => encodeQr("a", { ecc: "X" as QrEcc }), RangeError);
});

Deno.test("renderQrSvg: one path of merged runs inside a 4-module quiet zone", () => {
  const m = encodeQr("a");
  const svg = renderQrSvg(m);
  assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"'));
  assert(svg.includes('shape-rendering="crispEdges"'));
  assert(svg.includes('<rect width="29" height="29" fill="#fff"/>'));
  // The top finder row is seven dark modules: one run, offset by the margin.
  assert(svg.includes("M4 4h7v1h-7z"));
  assertEquals((svg.match(/<path /g) ?? []).length, 1);
  assert(!/<script|href|on[a-z]+=/i.test(svg), "nothing active or external");
  // Count the dark modules the path draws: every run's width adds up to the matrix's total.
  const drawn = [...svg.matchAll(/h(\d+)v1/g)].reduce((n, [, w]) => n + Number(w), 0);
  assertEquals(drawn, m.flat().filter(Boolean).length);
});

Deno.test("renderQrSvg: margin, size, colours and an escaped title", () => {
  const m = encodeQr("a");
  const svg = renderQrSvg(m, {
    margin: 0,
    size: 200,
    color: "#123456",
    background: "white",
    title: `<script>"x"&'y'</script>`,
  });
  assert(svg.includes('viewBox="0 0 21 21" width="200" height="200" role="img"'));
  assert(svg.includes('fill="#123456"') && svg.includes('fill="white"'));
  assert(
    svg.includes("<title>&#60;script&#62;&#34;x&#34;&#38;&#39;y&#39;&#60;/script&#62;</title>"),
  );
  assert(!svg.includes("<script"));
  assert(svg.includes("M0 0h7v1h-7z"));
});

Deno.test("renderQrSvg: refuses an option that could break the markup or the symbol", () => {
  const m = encodeQr("a");
  assertThrows(() => renderQrSvg(m, { color: 'red" onload="x' }), TypeError);
  assertThrows(() => renderQrSvg(m, { background: "url(#x)" }), TypeError);
  assertThrows(() => renderQrSvg(m, { margin: -1 }), RangeError);
  assertThrows(() => renderQrSvg(m, { margin: 1.5 }), RangeError);
  assertThrows(() => renderQrSvg(m, { size: 0 }), RangeError);
  assertThrows(() => renderQrSvg(m, { size: Number.NaN }), RangeError);
});
