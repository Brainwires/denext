// Wire codec — a JSON superset for the values JSON silently loses.
//
// `JSON.stringify` turns a `Map` into `{}`, `NaN`/`Infinity` into `null`, `-0` into `0`, drops
// `undefined` array entries to `null` and object fields entirely, and throws on a `BigInt`.
// Every denext wire — typed API bodies, Server Action args/results, Live `data` frames, and
// Flight props — used to inherit those losses. This module encodes such values as `$`-tagged
// objects (`{ $: "D", v: iso }` is the existing Flight `Date` convention) and decodes them back.
//
// Tags: `D` Date · `u` undefined · `n` BigInt · `N` NaN / Infinity / -Infinity / -0 · `M` Map ·
// `S` Set · `U` URL. Deliberately NOT encoded: `RegExp` (an attacker-supplied pattern in action
// args is a ReDoS primitive the moment a handler executes it), `Error` (prototype instantiation +
// stack leakage), class instances / prototypes (the decoder must never construct arbitrary
// classes), `Symbol`, functions, typed arrays (a base64 follow-up). A top-level `undefined` is
// "no body", not a value.
//
// Forgery resistance: a user object key that starts with `$` is doubled on encode and
// un-doubled on decode (the same rule as Flight's `escapeFlightKey`), so an un-escaped `$`
// object on the wire is ALWAYS a codec tag and can never be user data re-read as one. The
// decoder skips `__proto__` / `constructor` / `prototype` keys (before and after un-escaping),
// builds plain `{}` literals only, and bounds depth and node count so a hostile payload cannot
// exhaust the stack or the heap.
//
// The encoder is wire-encode.ts, a file of its own: a browser page that only decodes (the Flight
// client) must not statically reach the encoder's file, or the bundler places its code in the
// page's startup chunks for whichever lazy chunk encodes (a Server Action call).
//
// Performance: `encodeWire` is a copy-on-write walk — an unchanged subtree is returned by
// reference, so a plain-JSON payload costs one property visit per node and zero allocation
// before the single native `JSON.stringify`. Decoding is gated by the sender: the
// `x-denext-wire: 1` header / `enc: 1` envelope field is set only when `tagged` was true, so
// plain JSON bodies never pay for a decode walk.

/** The `enc` envelope value marking a codec-encoded JSON field (actions, Live frames, batches). */
export const WIRE_ENC = 1 as const;

/** The HTTP header (value `"1"`) marking a codec-encoded JSON request/response body. */
export const WIRE_HEADER = "x-denext-wire";

/** Options bounding {@link decodeWire} against hostile payloads. */
export interface DecodeWireOptions {
  /** Maximum nesting depth (default 256). */
  maxDepth?: number;
  /** Maximum number of values visited (default 1 000 000). */
  maxNodes?: number;
}

/** Thrown by {@link decodeWire} for a malformed or over-limit payload (a server maps it to 400). */
export class WireCodecError extends Error {
  /**
   * Create a codec error.
   *
   * @param message What was wrong with the payload.
   */
  constructor(message: string) {
    super(message);
    this.name = "WireCodecError";
  }
}

/** Sentinel returned by {@link decodeTagged} for an object that is not a codec tag. */
export const NOT_TAGGED: unique symbol = /* @__PURE__ */ Symbol("denext.wire.notTagged");

/** BigInt digits accepted on decode — `BigInt()` on a huge string is quadratic. */
const BIGINT_RE = /^-?\d{1,1024}$/;
/**
 * The non-finite / negative-zero enum carried by the `N` tag. A `Map`, not an object literal:
 * `v in {…}` also answers for inherited names, so `{ $: "N", v: "__proto__" }` would decode to
 * `Object.prototype` and `v: "constructor"` to the `Object` function — a prototype-pollution /
 * gadget primitive in Server Action args and API bodies.
 */
const NON_FINITE = new Map<string, number>([
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["-0", -0],
]);

// ── Decode ───────────────────────────────────────────────────────────────────

interface DecodeCtx {
  maxDepth: number;
  budget: number;
}

/**
 * Decode an already-`JSON.parse`d wire payload: revive codec tags, un-escape `$` keys, and
 * drop prototype-polluting keys. Only call it when the sender flagged the payload
 * ({@link WIRE_HEADER} / `enc: 1`); plain JSON needs no decode.
 *
 * @param parsed The parsed JSON value.
 * @param options Depth / node bounds.
 * @returns The revived value.
 * @throws WireCodecError on an unknown tag, a malformed tag body, or an exceeded bound.
 */
export function decodeWire(parsed: unknown, options: DecodeWireOptions = {}): unknown {
  const ctx: DecodeCtx = {
    maxDepth: options.maxDepth ?? 256,
    budget: options.maxNodes ?? 1_000_000,
  };
  return decode(parsed, 0, ctx);
}

function decode(value: unknown, depth: number, ctx: DecodeCtx): unknown {
  if (--ctx.budget < 0) throw new WireCodecError("wire codec: too many values");
  if (depth > ctx.maxDepth) throw new WireCodecError("wire codec: payload too deep");
  if (value === null || typeof value !== "object") return value;
  const recurse = (v: unknown) => decode(v, depth + 1, ctx);
  if (Array.isArray(value)) return value.map(recurse);
  const revived = decodeTagged(value as Record<string, unknown>, recurse);
  if (revived !== NOT_TAGGED) return revived;
  if (typeof (value as { $?: unknown }).$ === "string") {
    throw new WireCodecError(
      `wire codec: unknown tag ${JSON.stringify((value as { $: string }).$)}`,
    );
  }
  return decodePlain(value as Record<string, unknown>, recurse);
}

/** Skipped when rebuilding objects: assigning them would hit the inherited prototype setter. */
function isUnsafeKey(k: string): boolean {
  return k === "__proto__" || k === "constructor" || k === "prototype";
}

function decodePlain(value: Record<string, unknown>, recurse: (v: unknown) => unknown): unknown {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value)) {
    const key = k.startsWith("$") ? k.slice(1) : k;
    if (isUnsafeKey(k) || isUnsafeKey(key)) continue;
    out[key] = recurse(value[k]);
  }
  return out;
}

/**
 * Revive one `$`-tagged object, or return {@link NOT_TAGGED} when `obj.$` is not a codec tag.
 * This is the ONE tag switch: {@link decodeWire} and the Flight client both call it, so the
 * two decoders cannot drift. Nested values go through `recurse` (the caller's own step).
 *
 * @param obj A parsed JSON object (possibly a tag).
 * @param recurse Decodes a nested value.
 * @returns The revived value, or {@link NOT_TAGGED}.
 * @throws WireCodecError when a known tag carries a malformed body.
 */
export function decodeTagged(
  obj: Record<string, unknown>,
  recurse: (v: unknown) => unknown,
): unknown | typeof NOT_TAGGED {
  const v = obj.v;
  switch (obj.$) {
    case "D":
      return decodeDate(v);
    case "u":
      return undefined;
    case "n":
      if (typeof v !== "string" || !BIGINT_RE.test(v)) throw malformed("n");
      return BigInt(v);
    case "N":
      if (typeof v !== "string" || !NON_FINITE.has(v)) throw malformed("N");
      return NON_FINITE.get(v);
    case "M":
      return decodeMap(v, recurse);
    case "S":
      if (!Array.isArray(v)) throw malformed("S");
      return new Set(v.map(recurse));
    case "U":
      return decodeUrl(v);
    default:
      return NOT_TAGGED;
  }
}

function malformed(tagName: string): WireCodecError {
  return new WireCodecError(`wire codec: malformed "${tagName}" tag`);
}

function decodeDate(v: unknown): Date {
  if (typeof v !== "string") throw malformed("D");
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw malformed("D");
  return d;
}

function decodeMap(v: unknown, recurse: (v: unknown) => unknown): Map<unknown, unknown> {
  if (!Array.isArray(v)) throw malformed("M");
  const out = new Map<unknown, unknown>();
  for (const entry of v) {
    if (!Array.isArray(entry) || entry.length !== 2) throw malformed("M");
    out.set(recurse(entry[0]), recurse(entry[1]));
  }
  return out;
}

function decodeUrl(v: unknown): URL {
  if (typeof v !== "string") throw malformed("U");
  try {
    return new URL(v);
  } catch {
    throw malformed("U");
  }
}
