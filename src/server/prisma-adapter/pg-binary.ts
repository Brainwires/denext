/**
 * Postgres binary-format value decoders, producing the values Prisma's query engine reads
 * (the same ones `@prisma/adapter-pg` produces from the text format): `int8` and `numeric` as
 * decimal strings, `json` as its text, `bytea` as a number array, dates and times as their
 * ISO text, timestamps in UTC.
 *
 * The adapter reads every Postgres result with `.raw()` and decodes the bytes here instead of
 * taking `Deno.SQL`'s own JavaScript values: `Deno.SQL` reads a `timestamp` (without time zone)
 * as a `Date` at that local wall-clock time, which cannot hold a wall-clock time the process's
 * time zone skips (a daylight-saving gap) — and `timestamp(3)` is Prisma's default `DateTime`.
 *
 * @module
 */

import { type ColumnType, ColumnTypeEnum as T } from "./types.ts";

/** Turns one value's binary bytes into what Prisma reads. */
export type Decoder = (bytes: Uint8Array) => unknown;

/** A column's Prisma type and the decoder for its values. */
export interface Codec {
  /** The {@linkcode ColumnType} Prisma is told. */
  type: ColumnType;
  /** Decodes one non-null value. */
  decode: Decoder;
}

const utf8 = new TextDecoder();
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const pad = (n: number | bigint | string, width = 2) => String(n).padStart(width, "0");

/** Microseconds between 1970-01-01 and Postgres' epoch, 2000-01-01. */
const PG_EPOCH_MS = Date.UTC(2000, 0, 1);
const US_PER_DAY = 86_400_000_000n;
const INT64_MAX = 0x7fff_ffff_ffff_ffffn;
const INT64_MIN = -0x8000_0000_0000_0000n;

/** UTF-8 text (`text`, `varchar`, `json`, enums, …). */
export const decodeText: Decoder = (b) => utf8.decode(b);

/** `jsonb`: a version byte (1), then the JSON text. */
export const decodeJsonb: Decoder = (b) => utf8.decode(b.subarray(1));

/** `bool`. */
export const decodeBool: Decoder = (b) => b[0] !== 0;

/** `int2`. */
export const decodeInt2: Decoder = (b) => view(b).getInt16(0);

/** `int4`. */
export const decodeInt4: Decoder = (b) => view(b).getInt32(0);

/** `oid`: unsigned. */
export const decodeOid: Decoder = (b) => view(b).getUint32(0);

/** `int8`, as a decimal string (it may exceed `Number.MAX_SAFE_INTEGER`). */
export const decodeInt8: Decoder = (b) => view(b).getBigInt64(0).toString();

/** `float8`. */
export const decodeFloat8: Decoder = (b) => view(b).getFloat64(0);

/**
 * `float4`, as the shortest decimal that reads back as the same 32-bit float — what Postgres'
 * text output gives (`0.1`, not `0.10000000149011612`).
 */
export const decodeFloat4: Decoder = (b) => shortestFloat32(view(b).getFloat32(0));

/** The shortest decimal whose 32-bit float is `x`. */
export function shortestFloat32(x: number): number {
  if (!Number.isFinite(x)) return x;
  for (let precision = 1; precision < 9; precision++) {
    const y = Number(x.toPrecision(precision));
    if (Math.fround(y) === x) return y;
  }
  return Number(x.toPrecision(9));
}

const NUMERIC_SPECIAL: Record<number, string> = {
  0xc000: "NaN",
  0xd000: "Infinity",
  0xf000: "-Infinity",
};

/** `numeric`: base-10000 digit groups, as an exact decimal string at the value's scale. */
export const decodeNumeric: Decoder = (b) => {
  const v = view(b);
  const ndigits = v.getInt16(0);
  const weight = v.getInt16(2);
  const sign = v.getUint16(4);
  const dscale = v.getUint16(6);
  if (sign in NUMERIC_SPECIAL) return NUMERIC_SPECIAL[sign];
  const group = (i: number) => (i >= 0 && i < ndigits ? v.getInt16(8 + 2 * i) : 0);
  let int = weight < 0 ? "0" : String(group(0));
  for (let i = 1; i <= weight; i++) int += pad(group(i), 4);
  let frac = "";
  for (let i = weight + 1; frac.length < dscale; i++) frac += pad(group(i), 4);
  const digits = dscale > 0 ? `${int}.${frac.slice(0, dscale)}` : int;
  return sign === 0x4000 ? `-${digits}` : digits;
};

/**
 * `money`: a 64-bit count of the currency's smallest unit, as a decimal string with `fracDigits`
 * fractional digits — the server's `lc_monetary` decides how many (2 for `C` / `en_US`, 0 for
 * `ja_JP`, 3 for `ar_KW`).
 *
 * @param fracDigits The fractional digits of the session's `lc_monetary`.
 * @returns The decoder.
 */
export function moneyDecoder(fracDigits: number): Decoder {
  const unit = 10n ** BigInt(fracDigits);
  return (b) => {
    const count = view(b).getBigInt64(0);
    const abs = count < 0n ? -count : count;
    const int = `${count < 0n ? "-" : ""}${abs / unit}`;
    return fracDigits === 0 ? int : `${int}.${pad(abs % unit, fracDigits)}`;
  };
}

/** `money` under a two-digit `lc_monetary` (`C`, `en_US`): a count of cents. */
export const decodeMoney: Decoder = moneyDecoder(2);

/** `bytea`, as the number array Prisma reads. */
export const decodeBytea: Decoder = (b) => Array.from(b);

/** `uuid`: 16 bytes, as the canonical hyphenated text. */
export const decodeUuid: Decoder = (b) => {
  const hex = Array.from(b, (x) => pad(x.toString(16))).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
};

/** `YYYY-MM-DD` for a day count from 2000-01-01. */
function formatDays(days: number): string {
  const d = new Date(PG_EPOCH_MS + days * 86_400_000);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `HH:MM:SS[.ffffff]` for microseconds into a day (trailing fraction zeros dropped). */
function formatTimeOfDay(us: bigint): string {
  const secs = us / 1_000_000n;
  const fraction = us % 1_000_000n;
  const hms = `${pad(secs / 3600n)}:${pad((secs / 60n) % 60n)}:${pad(secs % 60n)}`;
  return fraction === 0n ? hms : `${hms}.${pad(fraction, 6).replace(/0+$/, "")}`;
}

/** `date`: days from 2000-01-01, as `YYYY-MM-DD` (`infinity` / `-infinity` as such). */
export const decodeDate: Decoder = (b) => {
  const days = view(b).getInt32(0);
  if (days === 0x7fff_ffff) return "infinity";
  if (days === -0x8000_0000) return "-infinity";
  return formatDays(days);
};

/** `time`: microseconds since midnight, as `HH:MM:SS[.ffffff]`. */
export const decodeTime: Decoder = (b) => formatTimeOfDay(view(b).getBigInt64(0));

/** `timetz`: the time of day, its zone dropped (as `@prisma/adapter-pg` reads it). */
export const decodeTimetz: Decoder = (b) => formatTimeOfDay(view(b).getBigInt64(0));

/**
 * `timestamp` / `timestamptz`: microseconds from 2000-01-01 (UTC for `timestamptz`, the
 * wall-clock time for `timestamp`), as `YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00`.
 */
export const decodeTimestamp: Decoder = (b) => {
  const us = view(b).getBigInt64(0);
  if (us === INT64_MAX) return "infinity";
  if (us === INT64_MIN) return "-infinity";
  let days = us / US_PER_DAY;
  let rest = us % US_PER_DAY;
  if (rest < 0n) {
    days -= 1n;
    rest += US_PER_DAY;
  }
  return `${formatDays(Number(days))}T${formatTimeOfDay(rest)}+00:00`;
};

/** `bit` / `varbit`: a bit count, then the bits, as a `0`/`1` string. */
export const decodeBits: Decoder = (b) => {
  const n = view(b).getInt32(0);
  let out = "";
  for (let i = 0; i < n; i++) out += (b[4 + (i >> 3)] >> (7 - (i & 7))) & 1;
  return out;
};

/** An IPv6 address's eight groups, with the longest run (≥ 2) of zero groups as `::`. */
function formatIpv6(addr: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, i) => (addr[2 * i] << 8) | addr[2 * i + 1]);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${Array.from(addr.subarray(12)).join(".")}`;
  }
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

/** `inet` / `cidr`: family, prefix bits, is-cidr flag, length, address. */
export const decodeInet: Decoder = (b) => {
  const [family, bits, isCidr] = b;
  const addr = b.subarray(4, 4 + b[3]);
  const v4 = family === 2;
  const text = v4 ? Array.from(addr).join(".") : formatIpv6(addr);
  const full = v4 ? 32 : 128;
  return isCidr || bits !== full ? `${text}/${bits}` : text;
};

/** A one-dimensional or nested array, each element read by `element`. */
export function decodeArray(element: Decoder): Decoder {
  return (b) => {
    const v = view(b);
    const ndim = v.getInt32(0);
    if (ndim === 0) return [];
    const dims = Array.from({ length: ndim }, (_, d) => v.getInt32(12 + 8 * d));
    let offset = 12 + 8 * ndim;
    const next = (): unknown => {
      const len = v.getInt32(offset);
      offset += 4;
      if (len < 0) return null;
      const value = element(b.subarray(offset, offset + len));
      offset += len;
      return value;
    };
    const build = (d: number): unknown[] =>
      Array.from({ length: dims[d] }, () => (d === ndim - 1 ? next() : build(d + 1)));
    return build(0);
  };
}

/** Built-in scalar types by OID: their Prisma type and decoder. */
export const SCALARS: ReadonlyMap<number, Codec> = new Map<number, Codec>([
  [16, { type: T.Boolean, decode: decodeBool }],
  [17, { type: T.Bytes, decode: decodeBytea }],
  [18, { type: T.Character, decode: decodeText }],
  [19, { type: T.Text, decode: decodeText }],
  [20, { type: T.Int64, decode: decodeInt8 }],
  [21, { type: T.Int32, decode: decodeInt2 }],
  [23, { type: T.Int32, decode: decodeInt4 }],
  [25, { type: T.Text, decode: decodeText }],
  [26, { type: T.Int64, decode: decodeOid }],
  [114, { type: T.Json, decode: decodeText }],
  [142, { type: T.Text, decode: decodeText }],
  [650, { type: T.Text, decode: decodeInet }],
  [700, { type: T.Float, decode: decodeFloat4 }],
  [701, { type: T.Double, decode: decodeFloat8 }],
  [790, { type: T.Numeric, decode: decodeMoney }],
  [869, { type: T.Text, decode: decodeInet }],
  [1042, { type: T.Text, decode: decodeText }],
  [1043, { type: T.Text, decode: decodeText }],
  [1082, { type: T.Date, decode: decodeDate }],
  [1083, { type: T.Time, decode: decodeTime }],
  [1114, { type: T.DateTime, decode: decodeTimestamp }],
  [1184, { type: T.DateTime, decode: decodeTimestamp }],
  [1266, { type: T.Time, decode: decodeTimetz }],
  [1560, { type: T.Text, decode: decodeBits }],
  [1562, { type: T.Text, decode: decodeBits }],
  [1700, { type: T.Numeric, decode: decodeNumeric }],
  [2950, { type: T.Uuid, decode: decodeUuid }],
  [3802, { type: T.Json, decode: decodeJsonb }],
]);
