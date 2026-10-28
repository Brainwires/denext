/**
 * A minimal, strict CBOR decoder (RFC 8949) for the two structures WebAuthn hands a relying
 * party: the attestation object and the COSE credential public key inside the authenticator
 * data. It decodes exactly what CTAP2's canonical encoding uses — unsigned and negative
 * integers, byte and text strings, arrays, maps, `false` / `true` / `null` — and refuses the
 * rest: indefinite lengths (RFC 8949 §3.2.1; CTAP2 canonical CBOR forbids them), tags,
 * floating point, `undefined`, simple values, integers beyond ±2^53, text that isn't valid
 * UTF-8, duplicate map keys (§5.6), and nesting deeper than a fixed bound. A decoder for
 * attacker-supplied bytes refuses what it doesn't need rather than guessing.
 *
 * {@linkcode decodeCborPrefix} also returns how many bytes the first item took — the
 * authenticator data holds a COSE key followed by optional extensions with no length
 * prefix (WebAuthn L3 §6.5.1), so the parser needs to know where the key ends.
 *
 * @module
 */

/** A decoded CBOR value. Maps keep their keys' types (COSE keys are integers). */
export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | Map<number | string, CborValue>;

/** Why decoding failed. */
export class CborError extends Error {
  override name = "CborError";
}

/** How deep arrays and maps may nest — an attestation object is three levels deep. */
const MAX_DEPTH = 16;
/** The most items one array or map may declare (bounds the work a hostile length costs). */
const MAX_ITEMS = 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A cursor over the input. */
interface Reader {
  bytes: Uint8Array;
  view: DataView;
  pos: number;
}

/** Take `n` bytes, or throw when the input ends first. */
function take(r: Reader, n: number): Uint8Array {
  if (n > r.bytes.length - r.pos) throw new CborError("cbor: unexpected end of input");
  const out = r.bytes.subarray(r.pos, r.pos + n);
  r.pos += n;
  return out;
}

/** The byte width of an extended argument, by additional info 24–27 (RFC 8949 §3). */
const ARGUMENT_WIDTH: Record<number, 1 | 2 | 4 | 8> = { 24: 1, 25: 2, 26: 4, 27: 8 };

/** Read a big-endian unsigned integer of `width` bytes at `at`, refusing one past 2^53. */
function readUint(view: DataView, at: number, width: 1 | 2 | 4 | 8): number {
  if (width === 1) return view.getUint8(at);
  if (width === 2) return view.getUint16(at);
  if (width === 4) return view.getUint32(at);
  const big = view.getBigUint64(at);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("cbor: integer too large");
  return Number(big);
}

/**
 * The argument of an item head (RFC 8949 §3): the low five bits, or the 1/2/4/8 bytes they
 * announce. 28–30 are reserved and 31 (indefinite length) is refused.
 */
function argument(r: Reader, info: number): number {
  if (info < 24) return info;
  const width = ARGUMENT_WIDTH[info];
  if (width === undefined) {
    throw new CborError(
      info === 31 ? "cbor: indefinite lengths are not allowed" : "cbor: reserved additional info",
    );
  }
  const at = r.pos;
  take(r, width);
  return readUint(r.view, at, width);
}

/** A declared array / map / string length, bounded by what is left of the input. */
function length(r: Reader, info: number, perItem: number): number {
  const n = argument(r, info);
  if (n * perItem > r.bytes.length - r.pos) throw new CborError("cbor: length exceeds input");
  return n;
}

/** A text string (major type 3): UTF-8, strictly. */
function textString(r: Reader, info: number): string {
  const bytes = take(r, length(r, info, 1));
  try {
    return utf8.decode(bytes);
  } catch {
    throw new CborError("cbor: text string is not valid UTF-8");
  }
}

/** An item count for an array or map, bounded. */
function count(r: Reader, info: number, perItem: number): number {
  const n = length(r, info, perItem);
  if (n > MAX_ITEMS) throw new CborError("cbor: too many items");
  return n;
}

/** An array (major type 4). */
function array(r: Reader, info: number, depth: number): CborValue[] {
  const n = count(r, info, 1);
  const out: CborValue[] = [];
  for (let i = 0; i < n; i++) out.push(item(r, depth + 1));
  return out;
}

/** A map (major type 5) with integer or text keys, none repeated (RFC 8949 §5.6). */
function map(r: Reader, info: number, depth: number): Map<number | string, CborValue> {
  const n = count(r, info, 2);
  const out = new Map<number | string, CborValue>();
  for (let i = 0; i < n; i++) {
    const key = item(r, depth + 1);
    if (typeof key !== "number" && typeof key !== "string") {
      throw new CborError("cbor: map keys must be integers or text");
    }
    if (out.has(key)) throw new CborError("cbor: duplicate map key");
    out.set(key, item(r, depth + 1));
  }
  return out;
}

/** The simple values WebAuthn uses (major type 7): `false`, `true`, `null` — nothing else. */
const SIMPLE: ReadonlyMap<number, boolean | null> = new Map([[20, false], [21, true], [22, null]]);

/** Decode one item at the cursor. */
function item(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError("cbor: nested too deeply");
  const head = take(r, 1)[0];
  const info = head & 0x1f;
  switch (head >> 5) {
    case 0: // unsigned integer
      return argument(r, info);
    case 1: // negative integer: −1 − n
      return -1 - argument(r, info);
    case 2: // byte string
      return take(r, length(r, info, 1)).slice();
    case 3:
      return textString(r, info);
    case 4:
      return array(r, info, depth);
    case 5:
      return map(r, info, depth);
    case 6:
      throw new CborError("cbor: tags are not supported");
    default: { // 7: simple values and floats
      const simple = SIMPLE.get(info);
      if (simple === undefined) throw new CborError("cbor: unsupported simple value or float");
      return simple;
    }
  }
}

/**
 * Decode the first CBOR item in `bytes` and report where it ended.
 *
 * @param bytes The input.
 * @returns The value and the number of bytes it occupied.
 * @throws {CborError} On malformed or unsupported input.
 */
export function decodeCborPrefix(bytes: Uint8Array): { value: CborValue; length: number } {
  const r: Reader = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    pos: 0,
  };
  const value = item(r, 0);
  return { value, length: r.pos };
}

/**
 * Decode `bytes` as exactly one CBOR item — trailing bytes are an error.
 *
 * @param bytes The input.
 * @returns The value.
 * @throws {CborError} On malformed, unsupported or trailing input.
 */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, length } = decodeCborPrefix(bytes);
  if (length !== bytes.length) throw new CborError("cbor: trailing bytes after the item");
  return value;
}
