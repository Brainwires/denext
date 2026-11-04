/**
 * secp256k1 public-key recovery from an ECDSA signature (SEC 1 v2 §4.1.6) — what Ethereum's
 * `personal_sign` verification is; Web Crypto has no secp256k1. Verification only: the inputs
 * are public (a message, a signature), so constant-time scalar multiplication is not needed,
 * but every check that makes recovery sound is here: `r` and `s` in `[1, n − 1]`, the low-`s`
 * rule (EIP-2), a recovery id of 0 or 1 (the `x = r` case — Ethereum's `v` of 27 / 28), `R` on
 * the curve, and `Q` not the point at infinity.
 *
 * Points are Jacobian (`X / Z², Y / Z³`) over `BigInt`s; a scalar multiplication is a plain
 * double-and-add.
 *
 * @module
 */

/** The field prime `p = 2²⁵⁶ − 2³² − 977`. */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
/** The group order `n`. */
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

/** An affine point, or `null` for the point at infinity. */
export type Point = { x: bigint; y: bigint } | null;
type Jacobian = { x: bigint; y: bigint; z: bigint };

const INFINITY: Jacobian = { x: 0n, y: 1n, z: 0n };
/** The generator. */
export const G: Point = { x: GX, y: GY };

/**
 * `a mod m`, non-negative.
 *
 * @param a The value.
 * @param m The modulus.
 * @returns The residue.
 */
export function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/**
 * `base^exp mod m`.
 *
 * @param base The base.
 * @param exp The exponent (non-negative).
 * @param m The modulus.
 * @returns The power.
 */
function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/**
 * The inverse of `a` modulo the prime `m` (Fermat).
 *
 * @param a The value (not a multiple of `m`).
 * @param m The prime modulus.
 * @returns `a⁻¹ mod m`.
 */
export function invert(a: bigint, m: bigint): bigint {
  return powMod(a, m - 2n, m);
}

function double(p: Jacobian): Jacobian {
  if (p.z === 0n || p.y === 0n) return INFINITY;
  const ysq = mod(p.y * p.y, P);
  const s = mod(4n * p.x * ysq, P);
  const m = mod(3n * p.x * p.x, P); // a = 0
  const x = mod(m * m - 2n * s, P);
  const y = mod(m * (s - x) - 8n * ysq * ysq, P);
  const z = mod(2n * p.y * p.z, P);
  return { x, y, z };
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1z1 = mod(p.z * p.z, P);
  const z2z2 = mod(q.z * q.z, P);
  const u1 = mod(p.x * z2z2, P);
  const u2 = mod(q.x * z1z1, P);
  const s1 = mod(p.y * q.z * z2z2, P);
  const s2 = mod(q.y * p.z * z1z1, P);
  if (u1 === u2) return s1 === s2 ? double(p) : INFINITY;
  const h = mod(u2 - u1, P);
  const r = mod(s2 - s1, P);
  const hh = mod(h * h, P);
  const hhh = mod(h * hh, P);
  const v = mod(u1 * hh, P);
  const x = mod(r * r - hhh - 2n * v, P);
  const y = mod(r * (v - x) - s1 * hhh, P);
  const z = mod(h * p.z * q.z, P);
  return { x, y, z };
}

function toJacobian(p: Point): Jacobian {
  return p ? { x: p.x, y: p.y, z: 1n } : INFINITY;
}

function toAffine(p: Jacobian): Point {
  if (p.z === 0n) return null;
  const zi = invert(p.z, P);
  const zi2 = mod(zi * zi, P);
  return { x: mod(p.x * zi2, P), y: mod(p.y * zi2 * zi, P) };
}

/**
 * `k·point`.
 *
 * @param point The point.
 * @param k The scalar (reduced mod `n` first).
 * @returns The product.
 */
export function multiply(point: Point, k: bigint): Point {
  let scalar = mod(k, N);
  let acc = INFINITY;
  let base = toJacobian(point);
  while (scalar > 0n) {
    if (scalar & 1n) acc = add(acc, base);
    base = double(base);
    scalar >>= 1n;
  }
  return toAffine(acc);
}

/**
 * `a + b`.
 *
 * @param a A point.
 * @param b A point.
 * @returns The sum.
 */
function addPoints(a: Point, b: Point): Point {
  return toAffine(add(toJacobian(a), toJacobian(b)));
}

/**
 * Whether `point` satisfies `y² = x³ + 7` over the field.
 *
 * @param point The point.
 * @returns `true` on the curve.
 */
function onCurve(point: { x: bigint; y: bigint }): boolean {
  return point.x < P && point.y < P &&
    mod(point.y * point.y - (point.x * point.x * point.x + 7n), P) === 0n;
}

/** The point with this `x` whose `y` has the given parity, or `null` when none exists. */
function liftX(x: bigint, odd: boolean): Point {
  if (x <= 0n || x >= P) return null;
  const rhs = mod(x * x * x + 7n, P);
  const y = powMod(rhs, (P + 1n) / 4n, P); // p ≡ 3 (mod 4)
  if (mod(y * y, P) !== rhs) return null;
  return { x, y: ((y & 1n) === 1n) === odd ? y : P - y };
}

/**
 * Big-endian bytes to an integer.
 *
 * @param bytes The bytes.
 * @returns The integer.
 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * An integer as 32 big-endian bytes.
 *
 * @param value The integer (`< 2²⁵⁶`).
 * @returns The bytes.
 */
export function bigIntTo32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Recover the public key that signed `hash` (SEC 1 §4.1.6), refusing anything a strict
 * verifier refuses: `r` / `s` out of range, a high `s` (EIP-2), a recovery id other than 0 / 1,
 * an `R` off the curve, an infinite `Q`.
 *
 * @param hash The 32-byte message hash.
 * @param r The signature's `r`.
 * @param s The signature's `s`.
 * @param recovery The recovery id (0 or 1: the parity of `R.y`).
 * @returns The public key, or `null` when the signature is refused.
 */
export function recoverPublicKey(
  hash: Uint8Array,
  r: bigint,
  s: bigint,
  recovery: number,
): Point {
  if (hash.length !== 32) return null;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;
  if (s > N / 2n) return null; // EIP-2: only the low-s form
  if (recovery !== 0 && recovery !== 1) return null;
  const big = liftX(r, recovery === 1);
  if (!big) return null;
  const e = mod(bytesToBigInt(hash), N);
  const rInv = invert(r, N);
  const u1 = mod(-e * rInv, N);
  const u2 = mod(s * rInv, N);
  const q = addPoints(multiply(G, u1), multiply(big, u2));
  return q && onCurve(q) ? q : null;
}
