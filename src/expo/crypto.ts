/**
 * `expo-crypto` for denext: hashing and randomness over WebCrypto (`crypto.subtle`,
 * `crypto.getRandomValues`, `crypto.randomUUID`), which every Capacitor web view and modern
 * browser has.
 *
 * WebCrypto has no MD2/MD4/MD5: those algorithms reject. The AES API (`aesEncryptAsync`,
 * `AESEncryptionKey`, …) is not provided (see the manifest).
 *
 * @example
 * ```ts
 * import * as Crypto from "denext/expo/crypto";
 *
 * const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, "hello");
 * const id = Crypto.randomUUID();
 * ```
 *
 * @module
 */

import { bytesToBase64 } from "../mobile/base64.ts";

/** A digest algorithm. */
export enum CryptoDigestAlgorithm {
  /** SHA-1. */
  SHA1 = "SHA-1",
  /** SHA-256. */
  SHA256 = "SHA-256",
  /** SHA-384. */
  SHA384 = "SHA-384",
  /** SHA-512. */
  SHA512 = "SHA-512",
  /** MD2 (not in WebCrypto: rejects). */
  MD2 = "MD2",
  /** MD4 (not in WebCrypto: rejects). */
  MD4 = "MD4",
  /** MD5 (not in WebCrypto: rejects). */
  MD5 = "MD5",
}

/** How {@linkcode digestStringAsync} encodes the digest. */
export enum CryptoEncoding {
  /** Lower-case hex. */
  HEX = "hex",
  /** Base64. */
  BASE64 = "base64",
}

/** Options for {@linkcode digestStringAsync}. */
export interface CryptoDigestOptions {
  /** The digest's encoding (default hex). */
  encoding: CryptoEncoding;
}

/** A digest, as a hex or base64 string. */
export type Digest = string;

/** The algorithms WebCrypto can digest. */
const SUBTLE_ALGORITHMS: readonly string[] = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];

/** `algorithm`, checked against what WebCrypto supports. */
function subtleAlgorithm(algorithm: CryptoDigestAlgorithm): string {
  if (!SUBTLE_ALGORITHMS.includes(algorithm)) {
    throw new Error(`${algorithm} is not supported here (WebCrypto has SHA-1 and SHA-2 only)`);
  }
  return algorithm;
}

/**
 * `byteCount` random bytes.
 *
 * @param byteCount How many (0–1024).
 * @returns The bytes.
 */
export function getRandomBytes(byteCount: number): Uint8Array {
  if (!Number.isInteger(byteCount) || byteCount < 0 || byteCount > 1024) {
    throw new TypeError(`getRandomBytes: byteCount must be an integer from 0 to 1024`);
  }
  return crypto.getRandomValues(new Uint8Array(byteCount));
}

/**
 * Async form of {@linkcode getRandomBytes}.
 *
 * @param byteCount How many (0–1024).
 * @returns The bytes.
 */
export function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return Promise.resolve().then(() => getRandomBytes(byteCount));
}

/**
 * Fill `typedArray` with random values.
 *
 * @param typedArray An integer typed array.
 * @returns The same array.
 */
export function getRandomValues<T extends ArrayBufferView>(typedArray: T): T {
  return crypto.getRandomValues(typedArray as unknown as Uint8Array<ArrayBuffer>) as unknown as T;
}

/**
 * A random v4 UUID.
 *
 * @returns The UUID.
 */
export function randomUUID(): string {
  return crypto.randomUUID();
}

/**
 * The digest of `data`.
 *
 * @param algorithm A SHA algorithm.
 * @param data The bytes.
 * @returns The digest.
 */
export async function digest(
  algorithm: CryptoDigestAlgorithm,
  data: BufferSource,
): Promise<ArrayBuffer> {
  return await crypto.subtle.digest(subtleAlgorithm(algorithm), data);
}

/**
 * The digest of the UTF-8 string `data`, hex (default) or base64 encoded.
 *
 * @param algorithm A SHA algorithm.
 * @param data The string.
 * @param options The encoding.
 * @returns The encoded digest.
 */
export async function digestStringAsync(
  algorithm: CryptoDigestAlgorithm,
  data: string,
  options: CryptoDigestOptions = { encoding: CryptoEncoding.HEX },
): Promise<Digest> {
  const bytes = new Uint8Array(await digest(algorithm, new TextEncoder().encode(data)));
  if (options.encoding === CryptoEncoding.BASE64) return bytesToBase64(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
