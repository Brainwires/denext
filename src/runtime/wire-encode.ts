// Wire codec, encode half: tag what JSON would lose (see wire-codec.ts for the format and its
// decoder). A file of its own, imported only by the code that SENDS codec values (a Server Action
// call, a typed API body, a Live frame, the server's responses), so a page that only receives
// them never statically reaches it and the bundler never places it in a startup chunk.

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

/** Max encode depth — deeper is a cycle or a pathological value (JSON's own failure mode). */
const MAX_ENCODE_DEPTH = 64;

interface EncodeCtx {
  tagged: boolean;
}

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
  return canonical(prepare(parts, 0, { tagged: false }));
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
