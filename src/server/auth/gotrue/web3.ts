/**
 * Web3 sign-in messages: Sign-In with Ethereum (EIP-4361) and Sign-In with Solana, as
 * `supabase.auth.signInWithWeb3()` builds them, parsed and their signatures verified.
 *
 * - **Ethereum**: the signature is `personal_sign` over the message (EIP-191:
 *   `keccak256("\x19Ethereum Signed Message:\n" + len + message)`), 65 bytes `r ‖ s ‖ v`; the
 *   signer's address is recovered (`./secp256k1.ts`) and must equal the message's address. A
 *   mixed-case address in the message must carry a valid EIP-55 checksum.
 * - **Solana**: the signature is Ed25519 over the message bytes, checked with Web Crypto
 *   against the message's base58 address (the 32-byte public key).
 *
 * The message's fields are parsed strictly (each at most once, known names only); the policy
 * checks — domain, URI, chain, time window, nonce — are the caller's (`./routes-web3.ts`).
 *
 * @module
 */

import { base64UrlDecode } from "../oauth.ts";
import { keccak256 } from "./keccak.ts";
import { bigIntTo32, bytesToBigInt, recoverPublicKey } from "./secp256k1.ts";

/** A parsed sign-in message. */
export interface Web3Message {
  /** `ethereum` or `solana`. */
  chain: "ethereum" | "solana";
  /** The domain (RFC 3986 authority) that asked for the signature. */
  domain: string;
  /** The scheme the message names before the domain, when it does. */
  scheme?: string;
  /** The signer's address (Ethereum hex as written, Solana base58). */
  address: string;
  /** The statement, when present. */
  statement?: string;
  /** `URI`. */
  uri: string;
  /** `Version` (must be `1`). */
  version: string;
  /** `Chain ID`, when present (required for Ethereum). */
  chainId?: string;
  /** `Nonce`, when present. */
  nonce?: string;
  /** `Issued At`, epoch milliseconds. */
  issuedAt: number;
  /** `Expiration Time`, epoch milliseconds. */
  expirationTime?: number;
  /** `Not Before`, epoch milliseconds. */
  notBefore?: number;
  /** `Request ID`. */
  requestId?: string;
  /** `Resources`. */
  resources: string[];
}

/** Why a message or signature was refused (never shown verbatim to the client). */
export class Web3Error extends Error {
  /**
   * @param message What was wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = "Web3Error";
  }
}

const HEADER_RE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your (Ethereum|Solana) account:$/;
const FIELDS: Record<string, keyof Web3Message> = {
  "URI": "uri",
  "Version": "version",
  "Chain ID": "chainId",
  "Nonce": "nonce",
  "Issued At": "issuedAt",
  "Expiration Time": "expirationTime",
  "Not Before": "notBefore",
  "Request ID": "requestId",
};
const FIELD_RE =
  /^(URI|Version|Chain ID|Nonce|Issued At|Expiration Time|Not Before|Request ID): (.+)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(value: string, name: string): number {
  const ms = ISO_RE.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Web3Error(`${name} is not an RFC 3339 date-time`);
  return ms;
}

/** Read the header, address and optional statement; return where the fields begin. */
function readPreamble(lines: string[]): {
  chain: Web3Message["chain"];
  domain: string;
  scheme?: string;
  address: string;
  statement?: string;
  next: number;
} {
  const header = HEADER_RE.exec(lines[0] ?? "");
  if (!header) throw new Web3Error("not a sign-in message");
  const address = lines[1] ?? "";
  let i = 2;
  while (lines[i] === "") i++;
  let statement: string | undefined;
  if (i < lines.length && !FIELD_RE.test(lines[i]) && !/^Resources:?$/.test(lines[i])) {
    statement = lines[i++];
    while (lines[i] === "") i++;
  }
  return {
    chain: header[3] === "Ethereum" ? "ethereum" : "solana",
    domain: header[2],
    ...(header[1] ? { scheme: header[1] } : {}),
    address,
    ...(statement !== undefined ? { statement } : {}),
    next: i,
  };
}

/** Read the `Key: value` fields and the `Resources` list. */
function readFields(lines: string[], start: number) {
  const fields: Record<string, string> = {};
  const resources: string[] = [];
  let inResources = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (inResources) {
      if (!line.startsWith("- ") || line.length < 3) throw new Web3Error("bad resource line");
      resources.push(line.slice(2));
      continue;
    }
    if (/^Resources:?$/.test(line)) {
      inResources = true;
      continue;
    }
    const match = FIELD_RE.exec(line);
    if (!match) throw new Web3Error("unexpected line in the message");
    if (match[1] in fields) throw new Web3Error(`duplicate field ${match[1]}`);
    fields[match[1]] = match[2];
  }
  return { fields, resources };
}

/**
 * Parse a sign-in message.
 *
 * @param text The message as signed.
 * @returns The fields.
 * @throws {Web3Error} For anything that is not a well-formed message.
 */
export function parseWeb3Message(text: string): Web3Message {
  if (text.length > 20 * 1024 || text.includes("\r")) {
    throw new Web3Error("message too long or CRLF");
  }
  const lines = text.split("\n");
  const preamble = readPreamble(lines);
  const { fields, resources } = readFields(lines, preamble.next);
  if (!fields["URI"] || !fields["Version"] || !fields["Issued At"]) {
    throw new Web3Error("URI, Version and Issued At are required");
  }
  const message: Web3Message = {
    chain: preamble.chain,
    domain: preamble.domain,
    address: preamble.address,
    uri: fields["URI"],
    version: fields["Version"],
    issuedAt: parseTime(fields["Issued At"], "Issued At"),
    resources,
  };
  if (preamble.scheme) message.scheme = preamble.scheme;
  if (preamble.statement !== undefined) message.statement = preamble.statement;
  for (const key of ["Chain ID", "Nonce", "Request ID"]) {
    if (fields[key] !== undefined) Reflect.set(message, FIELDS[key], fields[key]);
  }
  if (fields["Expiration Time"]) {
    message.expirationTime = parseTime(fields["Expiration Time"], "Expiration Time");
  }
  if (fields["Not Before"]) message.notBefore = parseTime(fields["Not Before"], "Not Before");
  return message;
}

// ── Ethereum ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/**
 * Lower-case hex of bytes.
 *
 * @param bytes The bytes.
 * @returns The hex digits (no `0x`).
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += (byte < 16 ? "0" : "") + byte.toString(16);
  return out;
}

/**
 * Whether `address` is a well-formed Ethereum address: `0x` + 40 hex digits, all lower case,
 * all upper case, or mixed case with a valid EIP-55 checksum.
 *
 * @param address The address as written.
 * @returns `true` when it is acceptable.
 */
export function validEthereumAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/**
 * The EIP-55 checksummed form of an address.
 *
 * @param address `0x` + 40 hex digits.
 * @returns The checksummed address.
 */
export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const digest = bytesToHex(keccak256(encoder.encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(digest[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * The EIP-191 `personal_sign` hash of a message.
 *
 * @param message The message text.
 * @returns The 32-byte hash.
 */
export function personalMessageHash(message: string): Uint8Array {
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak256(joined);
}

/**
 * The address of an uncompressed public key: the last 20 bytes of `keccak256(x ‖ y)`.
 *
 * @param point The public key.
 * @returns The lower-case `0x…` address.
 */
export function addressOfPublicKey(point: { x: bigint; y: bigint }): string {
  const raw = new Uint8Array(64);
  raw.set(bigIntTo32(point.x));
  raw.set(bigIntTo32(point.y), 32);
  return `0x${bytesToHex(keccak256(raw).slice(12))}`;
}

/**
 * Recover the address that `personal_sign`ed `message`.
 *
 * @param message The message text.
 * @param signature `0x` + 130 hex digits (`r ‖ s ‖ v`, `v` ∈ {0, 1, 27, 28}).
 * @returns The lower-case address, or `null` when the signature is refused.
 */
export function recoverEthereumAddress(message: string, signature: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  const bytes = signature.slice(2);
  const r = BigInt(`0x${bytes.slice(0, 64)}`);
  const s = BigInt(`0x${bytes.slice(64, 128)}`);
  const v = parseInt(bytes.slice(128), 16);
  const recovery = v >= 27 ? v - 27 : v;
  const key = recoverPublicKey(personalMessageHash(message), r, s, recovery);
  return key ? addressOfPublicKey(key) : null;
}

/**
 * Verify an Ethereum sign-in: the recovered signer is the message's address.
 *
 * @param message The parsed message.
 * @param text The message text.
 * @param signature The hex signature.
 * @returns `true` when the address signed the text.
 */
export function verifyEthereum(message: Web3Message, text: string, signature: string): boolean {
  if (!validEthereumAddress(message.address)) return false;
  const signer = recoverEthereumAddress(text, signature);
  return signer !== null && signer === message.address.toLowerCase();
}

// ── Solana ───────────────────────────────────────────────────────────────────

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decode base58 (Bitcoin alphabet).
 *
 * @param text The base58 string.
 * @returns The bytes, or `null` for a character outside the alphabet.
 */
export function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  let zeros = 0;
  while (text[zeros] === "1") zeros++;
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...body]);
}

/**
 * Encode base58 (Bitcoin alphabet).
 *
 * @param bytes The bytes.
 * @returns The string.
 */
export function base58Encode(bytes: Uint8Array): string {
  let value = bytesToBigInt(bytes);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** A base64url (or padded base64) signature as bytes, or `null`. */
function signatureBytes(signature: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(signature) || signature.length > 200) return null;
  try {
    return base64UrlDecode(signature.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
  } catch {
    return null;
  }
}

/**
 * Verify a Solana sign-in: an Ed25519 signature by the message's address over the text.
 *
 * @param message The parsed message.
 * @param text The message text.
 * @param signature The base64url signature (64 bytes).
 * @returns `true` when the address signed the text.
 */
export async function verifySolana(
  message: Web3Message,
  text: string,
  signature: string,
): Promise<boolean> {
  const key = base58Decode(message.address);
  const sig = signatureBytes(signature);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      new Uint8Array(sig),
      encoder.encode(text),
    );
  } catch {
    return false; // not a valid Ed25519 point
  }
}
