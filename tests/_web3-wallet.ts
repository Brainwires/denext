// Test wallets for Web3 sign-in: an Ethereum one (secp256k1 signing over the curve arithmetic in
// packages/auth/src/gotrue/secp256k1.ts, an EIP-1193 `request` like a browser wallet's) and a
// Solana one (Ed25519 through Web Crypto, `publicKey.toBase58()` + `signMessage()`). The
// recovery the server runs is checked separately against viem-generated fixtures, so a bug in
// the shared curve code can't make these tests agree with themselves.

import {
  bigIntTo32,
  bytesToBigInt,
  G,
  invert,
  mod,
  multiply,
  N,
} from "../packages/auth/src/gotrue/secp256k1.ts";
import {
  addressOfPublicKey,
  base58Encode,
  bytesToHex,
  personalMessageHash,
  toChecksumAddress,
} from "../packages/auth/src/gotrue/web3.ts";

/** An Ethereum test wallet. */
export interface EthereumTestWallet {
  /** The EIP-55 address. */
  address: string;
  /** `personal_sign` a message: `0x` + `r ‖ s ‖ v` (low s, v = 27 / 28). */
  sign(message: string): string;
  /** An EIP-1193 wallet for `signInWithWeb3({ chain: "ethereum", wallet })`. */
  provider: { request(args: { method: string; params?: unknown }): Promise<unknown> };
}

/** ECDSA over secp256k1 with a random k, normalized to low s. */
function signHash(key: bigint, hash: Uint8Array): string {
  const z = mod(bytesToBigInt(hash), N);
  for (;;) {
    const k = mod(bytesToBigInt(crypto.getRandomValues(new Uint8Array(32))), N);
    if (k === 0n) continue;
    const point = multiply(G, k)!;
    const r = mod(point.x, N);
    if (r === 0n) continue;
    let s = mod(invert(k, N) * (z + r * key), N);
    if (s === 0n) continue;
    let recovery = Number(point.y & 1n) + (point.x >= N ? 2 : 0);
    if (s > N / 2n) {
      s = N - s;
      recovery ^= 1;
    }
    return `0x${bytesToHex(bigIntTo32(r))}${bytesToHex(bigIntTo32(s))}${
      (27 + recovery).toString(16)
    }`;
  }
}

/**
 * An Ethereum wallet for a private key (random by default).
 *
 * @param privateKey `0x` + 64 hex digits.
 * @param chainId The chain the wallet reports.
 * @returns The wallet.
 */
export function ethereumWallet(privateKey?: string, chainId = 1): EthereumTestWallet {
  const key = privateKey
    ? BigInt(privateKey)
    : mod(bytesToBigInt(crypto.getRandomValues(new Uint8Array(32))), N - 1n) + 1n;
  const address = toChecksumAddress(addressOfPublicKey(multiply(G, key)!));
  const sign = (message: string) => signHash(key, personalMessageHash(message));
  return {
    address,
    sign,
    provider: {
      request({ method, params }) {
        if (method === "eth_requestAccounts") return Promise.resolve([address]);
        if (method === "eth_chainId") return Promise.resolve(`0x${chainId.toString(16)}`);
        if (method === "personal_sign") {
          const [data] = params as [string, string];
          const bytes = new Uint8Array(
            (data.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)),
          );
          return Promise.resolve(sign(new TextDecoder().decode(bytes)));
        }
        return Promise.reject(new Error(`unsupported ${method}`));
      },
    },
  };
}

/** A Solana test wallet. */
export interface SolanaTestWallet {
  /** The base58 address. */
  address: string;
  /** Sign bytes. */
  sign(message: string): Promise<Uint8Array>;
  /** A wallet for `signInWithWeb3({ chain: "solana", wallet })`. */
  wallet: {
    publicKey: { toBase58(): string };
    signMessage(message: Uint8Array): Promise<Uint8Array>;
  };
}

/**
 * A fresh Solana (Ed25519) wallet.
 *
 * @returns The wallet.
 */
export async function solanaWallet(): Promise<SolanaTestWallet> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const address = base58Encode(raw);
  const signBytes = async (bytes: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes));
  return {
    address,
    sign: (message) => signBytes(new TextEncoder().encode(message)),
    wallet: {
      publicKey: { toBase58: () => address },
      signMessage: (message) => signBytes(new Uint8Array(message)),
    },
  };
}

/**
 * A SIWE message as `signInWithWeb3` builds it.
 *
 * @param fields The address and overrides.
 * @returns The message text.
 */
export function siweMessage(fields: {
  address: string;
  domain?: string;
  uri?: string;
  chainId?: number;
  nonce?: string;
  issuedAt?: Date;
  expirationTime?: Date;
  notBefore?: Date;
  statement?: string;
}): string {
  const lines = [
    `${fields.domain ?? "app.test"} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    ...(fields.statement ? [fields.statement, ""] : [""]),
    `URI: ${fields.uri ?? "https://app.test/"}`,
    "Version: 1",
    `Chain ID: ${fields.chainId ?? 1}`,
    ...(fields.nonce ? [`Nonce: ${fields.nonce}`] : []),
    `Issued At: ${(fields.issuedAt ?? new Date()).toISOString()}`,
    ...(fields.expirationTime ? [`Expiration Time: ${fields.expirationTime.toISOString()}`] : []),
    ...(fields.notBefore ? [`Not Before: ${fields.notBefore.toISOString()}`] : []),
  ];
  return lines.join("\n");
}
