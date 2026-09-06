// The wire codec: a JSON superset that round-trips Date/undefined/BigInt/Map/Set/URL/non-finite,
// escapes `$` keys so user data can never forge a tag, refuses prototype-polluting keys, bounds
// depth and node count, and leaves plain JSON untouched (identity, no `tagged` flag).

import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import {
  decodeTagged,
  decodeWire,
  encodeWire,
  NOT_TAGGED,
  stableKey,
  WireCodecError,
} from "../src/runtime/wire-codec.ts";

/** Encode → JSON.parse → decode, the way every wire uses it. */
function roundTrip(value: unknown): { out: unknown; tagged: boolean } {
  const { body, tagged } = encodeWire(value);
  return { out: decodeWire(JSON.parse(body)), tagged };
}

Deno.test("plain JSON encodes as itself, untagged, without copying", () => {
  const value = { a: 1, b: "two", c: [true, null, { d: 3.5 }] };
  const { body, tagged } = encodeWire(value);
  assertEquals(tagged, false);
  assertEquals(body, JSON.stringify(value));
  // Copy-on-write: nothing changed, so the decoded shape equals the input and the encoder
  // returned the same JSON that JSON.stringify would (no allocation path exercised).
  assertEquals(decodeWire(JSON.parse(body)), value);
});

Deno.test("Date round-trips and sets tagged", () => {
  const d = new Date("2026-09-06T12:34:56.789Z");
  const { out, tagged } = roundTrip({ when: d });
  assert(tagged);
  assert((out as { when: Date }).when instanceof Date);
  assertEquals((out as { when: Date }).when.getTime(), d.getTime());
});

Deno.test("undefined survives inside arrays and objects", () => {
  const { out } = roundTrip({ a: undefined, list: [1, undefined, 3] });
  const o = out as { a: undefined; list: unknown[] };
  assert("a" in o && o.a === undefined);
  assertEquals(o.list, [1, undefined, 3]);
});

Deno.test("top-level undefined is 'no body'", () => {
  assertEquals(encodeWire(undefined), { body: "", tagged: false });
});

Deno.test("BigInt, Map, Set, URL, NaN, Infinity, -0 round-trip", () => {
  const value = {
    big: 12345678901234567890n,
    neg: -7n,
    map: new Map<unknown, unknown>([["k", 1], [2, new Date(0)]]),
    set: new Set([1, "a", new Date(0)]),
    url: new URL("https://denext.dev/docs?x=1#h"),
    nan: NaN,
    inf: Infinity,
    ninf: -Infinity,
    nzero: -0,
  };
  const { out, tagged } = roundTrip(value);
  assert(tagged);
  const o = out as typeof value;
  assertEquals(o.big, 12345678901234567890n);
  assertEquals(o.neg, -7n);
  assert(o.map instanceof Map);
  assertEquals(o.map.get("k"), 1);
  assert((o.map.get(2) as Date).getTime() === 0);
  assert(o.set instanceof Set && o.set.size === 3);
  assert(o.url instanceof URL && o.url.href === "https://denext.dev/docs?x=1#h");
  assert(Number.isNaN(o.nan));
  assertEquals(o.inf, Infinity);
  assertEquals(o.ninf, -Infinity);
  assert(Object.is(o.nzero, -0));
});

Deno.test("a user key starting with `$` is escaped, round-trips as data, and cannot forge a tag", () => {
  const value = { $: "D", v: "not a date", $$: 1, $x: { $: "M", v: [] } };
  const { body, tagged } = encodeWire(value);
  assert(tagged);
  const raw = JSON.parse(body) as Record<string, unknown>;
  assertEquals(Object.keys(raw).sort(), ["$$", "$$$", "$$x", "v"]);
  const out = decodeWire(raw) as typeof value;
  assertEquals(out, value);
  assertEquals(typeof out.$x, "object");
  assertEquals(out.$x.$, "M"); // stayed a string field, not a Map
});

Deno.test("decode refuses prototype-polluting keys before and after un-escaping", () => {
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":true},"$__proto__":{"x":1},"constructor":1,"ok":2}',
  );
  const out = decodeWire(hostile) as Record<string, unknown>;
  assertEquals(Object.keys(out), ["ok"]);
  assertEquals(({} as { polluted?: boolean }).polluted, undefined);
  assertStrictEquals(Object.getPrototypeOf(out), Object.prototype);
});

Deno.test("decode rejects unknown tags and malformed tag bodies", () => {
  assertThrows(() => decodeWire({ $: "Z" }), WireCodecError, "unknown tag");
  assertThrows(() => decodeWire({ $: "D", v: "nope" }), WireCodecError, 'malformed "D"');
  assertThrows(() => decodeWire({ $: "D", v: 5 }), WireCodecError);
  assertThrows(() => decodeWire({ $: "n", v: "12a" }), WireCodecError, 'malformed "n"');
  assertThrows(() => decodeWire({ $: "n", v: "9".repeat(1025) }), WireCodecError);
  assertThrows(() => decodeWire({ $: "N", v: "-NaN" }), WireCodecError);
  assertThrows(() => decodeWire({ $: "M", v: [[1]] }), WireCodecError, 'malformed "M"');
  assertThrows(() => decodeWire({ $: "M", v: {} }), WireCodecError);
  assertThrows(() => decodeWire({ $: "S", v: "x" }), WireCodecError);
  assertThrows(() => decodeWire({ $: "U", v: "not a url" }), WireCodecError, 'malformed "U"');
});

Deno.test("decode bounds depth and node count", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 300; i++) deep = [deep];
  assertThrows(() => decodeWire(deep), WireCodecError, "too deep");
  assertEquals(decodeWire(deep, { maxDepth: 400 }) !== undefined, true);
  const wide = Array.from({ length: 50 }, (_, i) => i);
  assertThrows(() => decodeWire(wide, { maxNodes: 10 }), WireCodecError, "too many values");
});

Deno.test("encode rejects functions, symbols, and cycles", () => {
  assertThrows(() => encodeWire({ f: () => 1 }), TypeError, "function");
  assertThrows(() => encodeWire([Symbol("s")]), TypeError, "symbol");
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assertThrows(() => encodeWire(cyc), TypeError, "too deep");
});

Deno.test("decodeTagged returns NOT_TAGGED for non-tag objects so a caller can fall through", () => {
  assertStrictEquals(decodeTagged({ a: 1 }, (v) => v), NOT_TAGGED);
  assertStrictEquals(decodeTagged({ $: "h", t: "div" }, (v) => v), NOT_TAGGED); // a Flight tag, not ours
  assertEquals(decodeTagged({ $: "u" }, (v) => v), undefined);
});

Deno.test("stableKey is order-independent for object keys and codec-aware", () => {
  const a = stableKey(["GET", "/x", { b: 2, a: 1 }, new Date(0)]);
  const b = stableKey(["GET", "/x", { a: 1, b: 2 }, new Date(0)]);
  assertEquals(a, b);
  assert(a !== stableKey(["GET", "/x", { a: 1, b: 3 }, new Date(0)]));
  assert(stableKey([1n]) !== stableKey([1]));
  assert(stableKey([new Map([["k", 1]])]) !== stableKey([{ k: 1 }]));
  assert(stableKey([undefined]) !== stableKey([null]));
});
