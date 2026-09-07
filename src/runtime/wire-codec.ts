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
// Performance: `encodeWire` is a copy-on-write walk — an unchanged subtree is returned by
// reference, so a plain-JSON payload costs one property visit per node and zero allocation
// before the single native `JSON.stringify`. Decoding is gated by the sender: the
// `x-denext-wire: 1` header / `enc: 1` envelope field is set only when `tagged` was true, so
// plain JSON bodies never pay for a decode walk.

/** The `enc` envelope value marking a codec-encoded JSON field (actions, Live frames, batches). */
export const WIRE_ENC = 1 as const;

/** The HTTP header (value `"1"`) marking a codec-encoded JSON request/response body. */
export const WIRE_HEADER = "x-denext-wire";

/** The result of {@link prepareWire}: the JSON-ready value and whether any node needed a tag. */
export interface PreparedWire {
  /** A value `JSON.stringify` can take as-is (tags applied, `$` keys escaped). */
  value: unknown;
  /** True when a codec tag or an escaped key was needed — the envelope must carry `enc: 1`. */
  tagged: boolean;
}

/** The result of {@link encodeWire}: the JSON text and whether any value needed a codec tag. */
export interface EncodedWire {
  /** The JSON body text (`""` for a top-level `undefined` — "no body"). */
  body: string;
  /** True when the body contains a codec tag or an escaped `$` key and MUST be decoded. */
  tagged: boolean;
}

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
export const NOT_TAGGED: unique symbol = Symbol("denext.wire.notTagged");

/** Max encode depth — deeper is a cycle or a pathological value (JSON's own failure mode). */
const MAX_ENCODE_DEPTH = 64;
/** BigInt digits accepted on decode — `BigInt()` on a huge string is quadratic. */
const BIGINT_RE = /^-?\d{1,1024}$/;
/** The non-finite / negative-zero enum carried by the `N` tag. */
const NON_FINITE: Record<string, number> = {
  NaN: NaN,
  Infinity: Infinity,
  "-Infinity": -Infinity,
  "-0": -0,
};

interface EncodeCtx {
  tagged: boolean;
}

// ── Encode ───────────────────────────────────────────────────────────────────

/**
 * Encode a value as JSON text, tagging what JSON would lose. Plain-JSON values are stringified
 * as-is (no allocation); `tagged` tells the caller whether to flag the payload for decoding.
 *
 * @param value The value to encode. A top-level `undefined` yields `body: ""` (no body).
 * @returns The JSON text and the `tagged` flag.
 * @throws TypeError on a function, symbol, or a value nested deeper than 64 levels (a cycle).
 */
export function encodeWire(value: unknown): EncodedWire {
  if (value === undefined) return { body: "", tagged: false };
  const { value: prepared, tagged } = prepareWire(value);
  return { body: JSON.stringify(prepared), tagged };
}

/**
 * The pre-stringify half of {@link encodeWire}, for a value that is embedded in a larger JSON
 * envelope (`{ args, enc: 1 }`, a Live frame's `value`): tags applied, keys escaped, nothing
 * stringified yet. Copy-on-write like `encodeWire`.
 *
 * @param value The value to prepare.
 * @returns The JSON-ready value and whether the envelope needs `enc: 1`.
 */
export function prepareWire(value: unknown): PreparedWire {
  const ctx: EncodeCtx = { tagged: false };
  return { value: prepare(value, 0, ctx), tagged: ctx.tagged };
}

/** Rewrite one value into its wire shape (copy-on-write: unchanged subtrees keep their identity). */
function prepare(value: unknown, depth: number, ctx: EncodeCtx): unknown {
  if (depth > MAX_ENCODE_DEPTH) throw new TypeError("wire codec: value too deep (cycle?)");
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return prepareNumber(value, ctx);
    case "undefined":
      return tag(ctx, { $: "u" });
    case "bigint":
      return tag(ctx, { $: "n", v: value.toString() });
    case "function":
    case "symbol":
      throw new TypeError(`wire codec: cannot encode a ${typeof value}`);
    default:
      return prepareObject(value as object, depth, ctx);
  }
}

function prepareNumber(n: number, ctx: EncodeCtx): unknown {
  if (Number.isFinite(n) && !Object.is(n, -0)) return n;
  return tag(ctx, { $: "N", v: Object.is(n, -0) ? "-0" : String(n) });
}

function tag(ctx: EncodeCtx, tagged: Record<string, unknown>): unknown {
  ctx.tagged = true;
  return tagged;
}

/** Objects: the built-ins the codec knows, then arrays, then plain-object walking. */
function prepareObject(value: object, depth: number, ctx: EncodeCtx): unknown {
  if (value instanceof Date) return tag(ctx, { $: "D", v: value.toISOString() });
  if (value instanceof Map) {
    const entries: unknown[] = [];
    for (const [k, v] of value) {
      entries.push([prepare(k, depth + 1, ctx), prepare(v, depth + 1, ctx)]);
    }
    return tag(ctx, { $: "M", v: entries });
  }
  if (value instanceof Set) {
    const items: unknown[] = [];
    for (const v of value) items.push(prepare(v, depth + 1, ctx));
    return tag(ctx, { $: "S", v: items });
  }
  if (value instanceof URL) return tag(ctx, { $: "U", v: value.href });
  if (Array.isArray(value)) return prepareArray(value, depth, ctx);
  return preparePlain(value as Record<string, unknown>, depth, ctx);
}

function prepareArray(value: unknown[], depth: number, ctx: EncodeCtx): unknown[] {
  let out: unknown[] | null = null;
  for (let i = 0; i < value.length; i++) {
    const v = prepare(value[i], depth + 1, ctx);
    if (out === null && v !== value[i]) out = value.slice(0, i);
    if (out !== null) out.push(v);
  }
  return out ?? value;
}

/** A plain object: escape a leading `$` in keys, rewrite values, copy only when something changed. */
function preparePlain(value: Record<string, unknown>, depth: number, ctx: EncodeCtx): unknown {
  let out: Record<string, unknown> | null = null;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const escaped = k.startsWith("$") ? "$" + k : k;
    if (escaped !== k) ctx.tagged = true;
    const v = prepare(value[k], depth + 1, ctx);
    if (out === null && (v !== value[k] || escaped !== k)) {
      out = {};
      for (let j = 0; j < i; j++) out[keys[j]] = value[keys[j]];
    }
    if (out !== null) out[escaped] = v;
  }
  return out ?? value;
}

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
      if (typeof v !== "string" || !(v in NON_FINITE)) throw malformed("N");
      return NON_FINITE[v];
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

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * A canonical string key for a tuple of values: codec-aware (a `Date`, `Map`, `BigInt` key by
 * their wire form) with object keys sorted, so structurally-equal inputs produce equal keys.
 * Used by the typed client's request dedupe and by `useApi`'s entry table.
 *
 * @param parts The values that identify one call (method, pattern, params, query, body, …).
 * @returns A deterministic string.
 */
export function stableKey(parts: unknown[]): string {
  const ctx: EncodeCtx = { tagged: false };
  return canonical(prepare(parts, 0, ctx));
}

/** JSON with sorted object keys (the wire-prepared value has no cycles or exotic types left). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return value === undefined ? '{"$":"u"}' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}
