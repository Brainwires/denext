// Web3 sign-in for `/auth/v1` (`POST /token?grant_type=web3`): Keccak-256 against Ethereum's
// vectors and viem's, secp256k1 public-key recovery against viem-generated signatures
// (tests/fixtures/web3-ethereum.json), EIP-55, the strict checks (high s, recovery id, wrong
// signer), message parsing, and the grant over raw HTTP — domain, URI, chain id, time window,
// single-use nonces, disabled chains and sign-ups, and Solana's Ed25519.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { keccak256 } from "../src/server/auth/gotrue/keccak.ts";
import { N } from "../src/server/auth/gotrue/secp256k1.ts";
import {
  base58Decode,
  base58Encode,
  parseWeb3Message,
  recoverEthereumAddress,
  toChecksumAddress,
  validEthereumAddress,
} from "../src/server/auth/gotrue/web3.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { base64UrlEncode } from "../src/server/auth/oauth.ts";
import type { GoTrueOptions } from "../src/server/auth/gotrue/options.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";
import { ethereumWallet, siweMessage, solanaWallet } from "./_web3-wallet.ts";

const fixtures = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/web3-ethereum.json", import.meta.url)),
) as {
  signatures: Array<
    { privateKey: string; address: string; message: string; signature: string; hash: string }
  >;
  keccak: Array<{ input: string; hash: string }>;
};

function claimsOf(token: string): Record<string, unknown> {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
}

const hex = (bytes: Uint8Array) =>
  "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

Deno.test("keccak256: Ethereum's vectors and viem's (block boundaries included)", () => {
  // The empty string and "abc" are the Keccak-256 (not SHA3-256) reference values.
  assertEquals(
    hex(keccak256(new Uint8Array())),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assertEquals(
    hex(keccak256(new TextEncoder().encode("abc"))),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
  for (const { input, hash } of fixtures.keccak) {
    assertEquals(hex(keccak256(new TextEncoder().encode(input))), hash, `len ${input.length}`);
  }
});

Deno.test("EIP-55: the EIP's own vectors, and mixed case must carry the checksum", () => {
  for (
    const address of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]
  ) {
    assertEquals(toChecksumAddress(address.toLowerCase()), address);
    assert(validEthereumAddress(address));
  }
  assert(validEthereumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "all lower");
  assert(validEthereumAddress("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED"), "all upper");
  assert(!validEthereumAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"), "bad checksum");
  assert(!validEthereumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1bea"), "short");
});

Deno.test("secp256k1: recovers viem's signers; refuses high s, bad v and tampering", () => {
  for (const { address, message, signature } of fixtures.signatures) {
    assertEquals(recoverEthereumAddress(message, signature), address.toLowerCase());
    // v as 0 / 1 is accepted too.
    const v = parseInt(signature.slice(130), 16) - 27;
    assertEquals(
      recoverEthereumAddress(message, signature.slice(0, 130) + v.toString(16).padStart(2, "0")),
      address.toLowerCase(),
    );
    // The malleable twin (n − s, flipped v) is refused (EIP-2).
    const s = BigInt("0x" + signature.slice(66, 130));
    const high = (N - s).toString(16).padStart(64, "0");
    const flipped = (v ^ 1) + 27;
    assertEquals(
      recoverEthereumAddress(message, signature.slice(0, 66) + high + flipped.toString(16)),
      null,
    );
    // A recovery id other than 27 / 28 / 0 / 1.
    assertEquals(recoverEthereumAddress(message, signature.slice(0, 130) + "1d"), null);
    // Another message recovers someone else.
    assertNotEquals(recoverEthereumAddress(message + "!", signature), address.toLowerCase());
  }
  const { message, signature } = fixtures.signatures[0];
  assertEquals(recoverEthereumAddress(message, "0x" + "00".repeat(65)), null, "r = s = 0");
  assertEquals(recoverEthereumAddress(message, signature.slice(0, -2)), null, "short");
});

Deno.test("the test wallet's signatures recover like viem's", () => {
  const fixture = fixtures.signatures[0];
  const wallet = ethereumWallet(fixture.privateKey);
  assertEquals(wallet.address, fixture.address);
  assertEquals(recoverEthereumAddress("hi", wallet.sign("hi")), fixture.address.toLowerCase());
});

Deno.test("base58 round-trips, leading zeros included", () => {
  const bytes = new Uint8Array([0, 0, 1, 2, 255, 7]);
  assertEquals(base58Decode(base58Encode(bytes)), bytes);
  assertEquals(base58Encode(new Uint8Array([0, 0])), "11");
  assertEquals(base58Decode("0OIl"), null);
});

Deno.test("parseWeb3Message: SIWE and SIWS, strict about shape", () => {
  const parsed = parseWeb3Message(fixtures.signatures[0].message);
  assertEquals(parsed.chain, "ethereum");
  assertEquals(parsed.domain, "app.test");
  assertEquals(parsed.statement, "Sign in to the app");
  assertEquals(parsed.chainId, "1");
  assertEquals(parsed.nonce, "abcdef123456");
  assertEquals(parsed.issuedAt, Date.parse("2026-01-01T00:00:00.000Z"));
  const solana = parseWeb3Message([
    "app.test wants you to sign in with your Solana account:",
    "8bP3",
    "",
    "Version: 1",
    "URI: https://app.test/",
    "Issued At: 2026-01-01T00:00:00Z",
    "Resources",
    "- https://a.test",
  ].join("\n"));
  assertEquals(solana.chain, "solana");
  assertEquals(solana.statement, undefined);
  assertEquals(solana.resources, ["https://a.test"]);
  const bad = [
    "hello",
    fixtures.signatures[0].message + "\nNonce: again",
    fixtures.signatures[0].message.replace("Issued At: 2026-01-01T00:00:00.000Z", "Issued At: now"),
    fixtures.signatures[0].message + "\nEvil: 1",
    fixtures.signatures[0].message.replace("URI: https://app.test/\n", ""),
  ];
  for (const text of bad) {
    let threw = false;
    try {
      parseWeb3Message(text);
    } catch {
      threw = true;
    }
    assert(threw, text);
  }
});

// ---- the grant over raw HTTP -------------------------------------------------------------

async function grant(app: SupabaseAuthApp, body: Record<string, unknown>) {
  const res = await app.fetch(`${ORIGIN}/auth/v1/token?grant_type=web3`, {
    method: "POST",
    headers: { apikey: app.publishableKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function withApp(
  fn: (app: SupabaseAuthApp) => Promise<void>,
  auth: GoTrueOptions = { web3: { ethereum: {}, solana: {} } },
) {
  const app = await supabaseAuthApp({ adapter: inMemoryAuthAdapter(), auth, withClient: false });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const ethereum = (message: string, signature: string) => ({
  chain: "ethereum",
  message,
  signature,
});

Deno.test("web3 grant: an Ethereum sign-in creates the user, then signs the same one in", async () => {
  await withApp(async (app) => {
    const wallet = ethereumWallet();
    // supabase-js writes the address lower-case; GoTrue keys the identity on it as written.
    const address = wallet.address.toLowerCase();
    const message = siweMessage({ address, statement: "Hi", nonce: "nonce0001" });
    const first = await grant(app, ethereum(message, wallet.sign(message)));
    assertEquals(first.status, 200, JSON.stringify(first.json));
    assert(first.json.access_token);
    // GoTrue's identity shape: provider "web3", sub "web3:<chain>:<address>", custom_claims.
    const identity = first.json.user.identities[0];
    assertEquals(identity.provider, "web3");
    assertEquals(identity.identity_data.sub, `web3:ethereum:${address}`);
    assertEquals(identity.identity_data.custom_claims, {
      address,
      chain: "ethereum",
      network: "1",
      domain: "app.test",
      statement: "Hi",
    });
    assertEquals(first.json.user.app_metadata.provider, "web3");
    const amr = claimsOf(first.json.access_token).amr as Array<Record<string, unknown>>;
    assertEquals(amr.map((entry) => entry.method), ["web3"]);
    assertEquals(amr[0].provider, undefined);
    const again = siweMessage({ address, nonce: "nonce0002" });
    const second = await grant(app, ethereum(again, wallet.sign(again)));
    assertEquals(second.status, 200);
    assertEquals(second.json.user.id, first.json.user.id, "the same address is the same user");
    // As in GoTrue, the checksummed spelling is another identity (another user).
    const checksummed = siweMessage({ address: wallet.address, nonce: "nonce0003" });
    const third = await grant(app, ethereum(checksummed, wallet.sign(checksummed)));
    assertEquals(
      third.json.user.identities[0].identity_data.sub,
      `web3:ethereum:${wallet.address}`,
    );
  });
});

Deno.test("web3 grant: a signature is single-use (nonce, or the message without one)", async () => {
  await withApp(async (app) => {
    const wallet = ethereumWallet();
    const message = siweMessage({ address: wallet.address, nonce: "replay001" });
    assertEquals((await grant(app, ethereum(message, wallet.sign(message)))).status, 200);
    const replay = await grant(app, ethereum(message, wallet.sign(message)));
    assertEquals(replay.status, 400);
    assertEquals(replay.json.error_code, "validation_failed");
    // Another message reusing the nonce.
    const other = siweMessage({ address: wallet.address, nonce: "replay001", statement: "x" });
    assertEquals((await grant(app, ethereum(other, wallet.sign(other)))).status, 400);
    // No nonce: the message itself is claimed.
    const bare = siweMessage({ address: wallet.address });
    assertEquals((await grant(app, ethereum(bare, wallet.sign(bare)))).status, 200);
    assertEquals((await grant(app, ethereum(bare, wallet.sign(bare)))).status, 400);
  });
});

Deno.test("web3 grant: the message must name this app, now", async () => {
  await withApp(async (app) => {
    const wallet = ethereumWallet();
    const refused = async (fields: Partial<Parameters<typeof siweMessage>[0]>) => {
      const message = siweMessage({ address: wallet.address, ...fields });
      const res = await grant(app, ethereum(message, wallet.sign(message)));
      assertEquals(res.status, 400, JSON.stringify(fields));
      return res.json;
    };
    await refused({ domain: "evil.test" });
    await refused({ uri: "https://evil.test/" });
    await refused({ chainId: 5 }); // chainIds: [1]
    await refused({ issuedAt: new Date(Date.now() + 5 * 60_000) });
    await refused({ issuedAt: new Date(Date.now() - 20 * 60_000) });
    await refused({ expirationTime: new Date(Date.now() - 1000) });
    await refused({ notBefore: new Date(Date.now() + 5 * 60_000) });
    await refused({ nonce: "short" });
    // Signed by someone else.
    const message = siweMessage({ address: wallet.address });
    const forged = await grant(app, ethereum(message, ethereumWallet().sign(message)));
    assertEquals(forged.json.error_code, "invalid_credentials");
    // A mis-checksummed address.
    const lower = wallet.address.slice(2);
    const flipped = "0x" +
      (lower[0] === lower[0].toUpperCase() ? lower[0].toLowerCase() : lower[0].toUpperCase()) +
      lower.slice(1);
    if (flipped.toLowerCase() !== flipped && flipped !== wallet.address) {
      const bad = siweMessage({ address: flipped });
      assertEquals((await grant(app, ethereum(bad, wallet.sign(bad)))).status, 400);
    }
    // An allow-listed domain works.
    const listed = siweMessage({ address: wallet.address, domain: "wallet.example" });
    assertEquals((await grant(app, ethereum(listed, wallet.sign(listed)))).status, 200);
  }, { web3: { ethereum: { chainIds: [1], domains: ["wallet.example"] } } });
});

Deno.test("web3 grant: off by default, per chain; disableSignup is respected", async () => {
  await withApp(async (app) => {
    const wallet = ethereumWallet();
    const message = siweMessage({ address: wallet.address });
    const res = await grant(app, ethereum(message, wallet.sign(message)));
    assertEquals(res.status, 422);
    assertEquals(res.json.error_code, "web3_provider_disabled");
    const chain = await grant(app, { chain: "bitcoin", message, signature: "0x" });
    assertEquals(chain.json.error_code, "web3_provider_disabled", "all of Web3 is off");
  }, {});
  await withApp(async (app) => {
    const wallet = ethereumWallet();
    const message = siweMessage({ address: wallet.address });
    const res = await grant(app, ethereum(message, wallet.sign(message)));
    assertEquals(res.status, 422);
    assertEquals(res.json.error_code, "web3_provider_disabled", "only Solana is on");
    const chain = await grant(app, { chain: "bitcoin", message, signature: "0x" });
    assertEquals(chain.status, 400);
    assertEquals(chain.json.error_code, "web3_unsupported_chain");
  }, { web3: { solana: {} } });
  await withApp(async (app) => {
    const wallet = ethereumWallet();
    const message = siweMessage({ address: wallet.address });
    const res = await grant(app, ethereum(message, wallet.sign(message)));
    assertEquals(res.json.error_code, "signup_disabled");
  }, { web3: { ethereum: {} }, disableSignup: true });
});

Deno.test("web3 grant: Solana — Ed25519 over the SIWS message", async () => {
  await withApp(async (app) => {
    const wallet = await solanaWallet();
    const message = [
      "app.test wants you to sign in with your Solana account:",
      wallet.address,
      "",
      "Version: 1",
      "URI: https://app.test/",
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const signature = base64UrlEncode(await wallet.sign(message));
    const ok = await grant(app, { chain: "solana", message, signature });
    assertEquals(ok.status, 200, JSON.stringify(ok.json));
    assertEquals(ok.json.user.identities[0].provider, "web3");
    assertEquals(ok.json.user.identities[0].identity_data.sub, `web3:solana:${wallet.address}`);
    assertEquals(ok.json.user.identities[0].identity_data.custom_claims.address, wallet.address);
    assertEquals(ok.json.user.identities[0].identity_data.custom_claims.network, "");
    const other = await solanaWallet();
    const forged = await grant(app, {
      chain: "solana",
      message: message.replace("Version: 1", "Version: 1\nNonce: abcdefgh1"),
      signature: base64UrlEncode(await other.sign(message)),
    });
    assertEquals(forged.json.error_code, "invalid_credentials");
    // An Ethereum message on the Solana chain is refused before any signature check.
    const eth = siweMessage({ address: ethereumWallet().address });
    assertEquals((await grant(app, { chain: "solana", message: eth, signature })).status, 400);
  });
});
