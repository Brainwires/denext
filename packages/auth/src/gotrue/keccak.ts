/**
 * Keccak-256 — the hash Ethereum uses (the original Keccak submission's padding, `0x01`, not
 * FIPS 202 SHA3-256's `0x06`; Web Crypto has neither). Keccak-f[1600] over 64-bit lanes held as
 * `BigInt`s: the inputs here are a sign-in message and a public key, a few blocks at most, so
 * clarity wins over speed. The round constants and rotation offsets are derived from their
 * definitions (the LFSR and the (x, y) walk of the Keccak reference), not typed in.
 *
 * @module
 */

const MASK = (1n << 64n) - 1n;
/** Keccak-256's rate: 1600 − 2·256 bits = 136 bytes. */
const RATE = 136;

function rotl(value: bigint, shift: number): bigint {
  const s = BigInt(shift % 64);
  return s === 0n ? value : ((value << s) | (value >> (64n - s))) & MASK;
}

/** The 24 round constants, from the degree-8 LFSR of the Keccak reference (§1.2). */
function roundConstants(): bigint[] {
  let r = 1;
  const lfsr = (): number => {
    const bit = r & 1;
    r = (r << 1) ^ ((r & 0x80) ? 0x171 : 0);
    r &= 0xff;
    return bit;
  };
  const constants: bigint[] = [];
  for (let round = 0; round < 24; round++) {
    let rc = 0n;
    for (let j = 0; j < 7; j++) {
      if (lfsr()) rc |= 1n << BigInt((1 << j) - 1);
    }
    constants.push(rc);
  }
  return constants;
}

/** ρ offsets and π targets: the walk (x, y) → (y, 2x + 3y) from (1, 0). */
function rhoPi(): { offsets: number[]; targets: number[] } {
  const offsets = new Array<number>(25).fill(0);
  const targets = new Array<number>(25).fill(0);
  let x = 1;
  let y = 0;
  for (let t = 0; t < 24; t++) {
    offsets[x + 5 * y] = ((t + 1) * (t + 2) / 2) % 64;
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  for (let x0 = 0; x0 < 5; x0++) {
    for (let y0 = 0; y0 < 5; y0++) targets[x0 + 5 * y0] = y0 + 5 * ((2 * x0 + 3 * y0) % 5);
  }
  return { offsets, targets };
}

const RC = roundConstants();
const { offsets: RHO, targets: PI } = rhoPi();

function theta(a: bigint[]): void {
  const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
  for (let x = 0; x < 5; x++) {
    const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
  }
}

function keccakF(a: bigint[]): void {
  const b = new Array<bigint>(25).fill(0n);
  for (let round = 0; round < 24; round++) {
    theta(a);
    for (let i = 0; i < 25; i++) b[PI[i]] = rotl(a[i], RHO[i]);
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = b[x + y] ^ ((~b[((x + 1) % 5) + y] & MASK) & b[((x + 2) % 5) + y]);
      }
    }
    a[0] ^= RC[round];
  }
}

/**
 * Keccak-256 of `input`.
 *
 * @param input The bytes.
 * @returns The 32-byte digest.
 */
export function keccak256(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.floor(input.length / RATE) * RATE + RATE);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + k]);
      state[i] ^= lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}
