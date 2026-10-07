/**
 * `uuid` from `expo` (expo-modules-core): random (v4) and name-based (v5) UUIDs. v5 is
 * synchronous, as Expo's is, so it hashes with a small SHA-1 here instead of
 * `crypto.subtle` (which only answers asynchronously). Internal: not a `denext/expo/*`
 * entrypoint. Nothing here runs at import time.
 *
 * @module
 */

/** The RFC 4122 namespaces Expo exports (`uuid.namespace`). */
enum Uuidv5Namespace {
  /** Fully-qualified domain names. */
  dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  /** URLs. */
  url = "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  /** ISO object identifiers. */
  oid = "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  /** X.500 distinguished names. */
  x500 = "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
}

/** The shape of Expo's `uuid` export. */
export interface UUID {
  /** A random UUID (version 4). */
  v4: () => string;
  /**
   * A name-based UUID (version 5): the SHA-1 of `namespace` followed by `name`.
   *
   * @param name The name (UTF-8 encoded).
   * @param namespace A UUID string, or its 16 bytes.
   */
  v5: (name: string, namespace: string | number[]) => string;
  /** The predefined namespaces (Expo's `Uuidv5Namespace`: `dns`, `url`, `oid`, `x500`). */
  namespace: {
    readonly dns: string;
    readonly url: string;
    readonly oid: string;
    readonly x500: string;
  };
}

/** SHA-1's round constants, one per 20 rounds. */
const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

/** Rotate a 32-bit word left by `n`. */
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

/** SHA-1's round function for round `i`: choose, parity, majority, parity. */
function sha1Round(i: number, b: number, c: number, d: number): number {
  if (i < 20) return (b & c) | (~b & d);
  if (i >= 40 && i < 60) return (b & c) | (b & d) | (c & d);
  return b ^ c ^ d;
}

/** Fold the 64-byte block at `offset` of `view` into the state `h`. */
function sha1Block(h: number[], view: DataView, offset: number, w: Uint32Array): void {
  for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
  for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  let [a, b, c, d, e] = h;
  for (let i = 0; i < 80; i++) {
    const t = (rotl(a, 5) + sha1Round(i, b, c, d) + e + SHA1_K[Math.floor(i / 20)] + w[i]) >>> 0;
    e = d;
    d = c;
    c = rotl(b, 30) >>> 0;
    b = a;
    a = t;
  }
  [a, b, c, d, e].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
}

/** The 20-byte SHA-1 digest of `bytes` (FIPS 180-4), synchronously. */
function sha1(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) sha1Block(h, view, block, w);
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
}

/** The 16 bytes of a UUID string (its hex pairs, dashes ignored). */
function uuidBytes(uuid: string): number[] {
  return (uuid.match(/[a-fA-F0-9]{2}/g) ?? []).map((hex) => parseInt(hex, 16));
}

/** `bytes` (the first 16) as `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. */
function formatUuid(bytes: ArrayLike<number>): string {
  const hex = Array.from({ length: 16 }, (_, i) => bytes[i].toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 16),
  ].map((part) => part.join("")).join("-");
}

/** A version 5 UUID of `name` in `namespace`, as Expo computes it. */
function uuidv5(name: string, namespace: string | number[]): string {
  const ns = typeof namespace === "string" ? uuidBytes(namespace) : namespace;
  if (!Array.isArray(ns) || ns.length !== 16) {
    throw new TypeError("namespace must be uuid string or an Array of 16 byte values");
  }
  const value = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + value.length);
  input.set(ns);
  input.set(value, 16);
  const bytes = sha1(input);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * A version 4 UUID: `crypto.randomUUID()` where it exists, else 16 bytes from
 * `crypto.getRandomValues` — `randomUUID` is limited to secure contexts, so a page served over
 * plain http (a dev server on the LAN) has only the latter, as Expo's own fallback does.
 */
function uuidv4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** Expo's `uuid`: `v4()` over the platform's CSPRNG, `v5(name, namespace)` over SHA-1. */
export const uuid: UUID = {
  v4: uuidv4,
  v5: uuidv5,
  namespace: Uuidv5Namespace,
};
