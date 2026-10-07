// The strict CBOR decoder behind passkeys (src/server/auth/cbor.ts): RFC 8949 Appendix A's
// examples for every type it accepts, decoded to the values the RFC lists, and the refusals —
// indefinite lengths, tags, floats, `undefined`, integers past 2^53, truncation, trailing bytes,
// duplicate map keys, invalid UTF-8, hostile lengths and nesting depth.

import { assertEquals, assertThrows } from "@std/assert";
import { CborError, decodeCbor, decodeCborPrefix } from "../src/server/auth/cbor.ts";

/** Hex → bytes. */
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

/** RFC 8949 Appendix A, the rows for the types the decoder accepts: [hex, expected]. */
const APPENDIX_A: Array<[string, unknown]> = [
  ["00", 0],
  ["01", 1],
  ["0a", 10],
  ["17", 23],
  ["1818", 24],
  ["1819", 25],
  ["1864", 100],
  ["1903e8", 1000],
  ["1a000f4240", 1000000],
  ["1b000000e8d4a51000", 1000000000000],
  ["20", -1],
  ["29", -10],
  ["3863", -100],
  ["3903e7", -1000],
  ["f4", false],
  ["f5", true],
  ["f6", null],
  ["40", new Uint8Array()],
  ["4401020304", hex("01020304")],
  ["60", ""],
  ["6161", "a"],
  ["6449455446", "IETF"],
  ["62225c", '"\\'],
  ["62c3bc", "ü"],
  ["63e6b0b4", "水"],
  ["64f0908591", "\u{10151}"],
  ["80", []],
  ["83010203", [1, 2, 3]],
  ["8301820203820405", [1, [2, 3], [4, 5]]],
  [
    "98190102030405060708090a0b0c0d0e0f101112131415161718181819",
    Array.from({ length: 25 }, (_, i) => i + 1),
  ],
  ["a0", new Map()],
  ["a201020304", new Map([[1, 2], [3, 4]])],
  ["a26161016162820203", new Map<string, unknown>([["a", 1], ["b", [2, 3]]])],
  ["826161a161626163", ["a", new Map([["b", "c"]])]],
];

Deno.test("cbor: RFC 8949 Appendix A examples decode to their listed values", () => {
  for (const [encoded, expected] of APPENDIX_A) {
    assertEquals(decodeCbor(hex(encoded)), expected, encoded);
  }
});

Deno.test("cbor: decodeCborPrefix reports where the first item ends", () => {
  // A COSE key followed by more bytes, as in authenticator data (WebAuthn L3 §6.5.1).
  assertEquals(decodeCborPrefix(hex("a201020304ffff")), {
    value: new Map([[1, 2], [3, 4]]),
    length: 5,
  });
});

/** Inputs the decoder must refuse, each with the reason. */
const REFUSED: Array<[string, string]> = [
  ["5f42010243030405ff", "indefinite"], // indefinite byte string (Appendix A)
  ["9fff", "indefinite"], // indefinite array
  ["bf6161016162f5ff", "indefinite"], // indefinite map
  ["c074323031332d30332d32315432303a30343a30305a", "tags"], // tag 0 (Appendix A)
  ["d82076687474703a2f2f7777772e6578616d706c652e636f6d", "tags"], // tag 32
  ["f90000", "float"], // half-precision 0.0
  ["fb3ff199999999999a", "float"], // 1.1
  ["f7", "simple"], // undefined
  ["f0", "simple"], // simple(16)
  ["1bffffffffffffffff", "too large"], // 2^64 − 1
  ["3bffffffffffffffff", "too large"], // −2^64
  ["1c", "reserved"], // additional info 28
  ["18", "end of input"], // truncated argument
  ["4401", "length exceeds"], // truncated byte string
  ["830102", "length exceeds"], // array announces 3, has 2
  ["0001", "trailing"],
  ["a201020103", "duplicate"], // {1: 2, 1: 3}
  ["a1820102f5", "map keys"], // array as a key
  ["62c328", "UTF-8"], // invalid UTF-8
  ["5a7fffffff", "length exceeds"], // a 2-GiB byte string claimed in 5 bytes
  ["9b0000000100000000", "length exceeds"], // a 4-billion-item array
];

Deno.test("cbor: refuses what WebAuthn never needs, and anything malformed", () => {
  for (const [encoded, reason] of REFUSED) {
    assertThrows(() => decodeCbor(hex(encoded)), CborError, reason, encoded);
  }
});

Deno.test("cbor: nesting deeper than the bound is refused (no stack exhaustion)", () => {
  assertEquals(decodeCbor(hex("81".repeat(16) + "00")), [[[[[[[[[[[[[[[[0]]]]]]]]]]]]]]]]);
  assertThrows(() => decodeCbor(hex("81".repeat(17) + "00")), CborError, "deeply");
  assertThrows(() => decodeCbor(hex("81".repeat(100_000) + "00")), CborError, "deeply");
});

Deno.test("cbor: an empty input is truncated, not undefined", () => {
  assertThrows(() => decodeCbor(new Uint8Array()), CborError, "end of input");
});
