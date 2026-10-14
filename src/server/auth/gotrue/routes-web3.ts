/**
 * Web3 sign-in (`supabase.auth.signInWithWeb3()` → `POST /token?grant_type=web3`): a signed
 * Sign-In with Ethereum (EIP-4361) or Sign-In with Solana message becomes a session for the
 * user whose `web3` identity is the signing address (created on first sign-in unless sign-ups
 * are disabled). The identity is GoTrue's: provider `web3`, provider id / `sub`
 * `web3:<chain>:<address>` (the address exactly as the message writes it), and `custom_claims`
 * `{ address, chain, network, domain, statement }`; the session's `amr` method is `web3`.
 *
 * Off unless `web3.ethereum` / `web3.solana` is configured. Before the signature counts, the
 * message must name this app: its domain is the app's host (or one in `domains`), its `URI` is
 * the site URL or an allowed redirect URL, its `Version` is 1, an Ethereum `Chain ID` is one of
 * `chainIds` (when set), `Issued At` is neither in the future nor older than `maxAge`, and
 * `Expiration Time` / `Not Before` hold. The nonce (or, without one, the whole message) is then
 * claimed once in the adapter, so a captured signature cannot be replayed — not even within
 * its validity window.
 *
 * @module
 */

import type { AdapterUser } from "../adapter.ts";
import { sha256Hex } from "../hash.ts";
import { signinStartLimiter } from "../rate-limit.ts";
import { linkIdentity } from "./accounts.ts";
import {
  checkCaptcha,
  type GoTrueContext,
  nowSeconds,
  ok,
  redirectTarget,
  spendIp,
} from "./context.ts";
import { GoTrueError } from "./errors.ts";
import type { GoTrueOptions } from "./options.ts";
import { type GoTrueSessionJson, startSession } from "./session.ts";
import {
  parseWeb3Message,
  verifyEthereum,
  verifySolana,
  type Web3Error,
  type Web3Message,
} from "./web3.ts";

/** Seconds a message stays acceptable after `Issued At`, by default. */
const DEFAULT_MAX_AGE = 600;
/** Clock skew tolerated for `Issued At` / `Not Before`, seconds. */
const SKEW = 30;

type Chain = "ethereum" | "solana";

/** A malformed request or message: GoTrue's `400 validation_failed`. */
function refuse(message: string): GoTrueError {
  return new GoTrueError(400, "validation_failed", message);
}

/**
 * A well-formed message that doesn't sign this user in here: GoTrue answers these as an OAuth
 * error, `400 { error: "invalid_grant", error_description }`.
 */
class InvalidGrant extends Error {}

const CHAIN_NAME: Record<Chain, string> = { ethereum: "Ethereum", solana: "Solana" };

function maxAge(options: GoTrueOptions): number {
  const value = options.web3?.maxAge ?? DEFAULT_MAX_AGE;
  return Number.isFinite(value) ? Math.min(86_400, Math.max(30, Math.floor(value))) : 600;
}

/**
 * The hosts a message's domain may name: the site URL's — `siteUrl` / the auth `canonicalOrigin`;
 * the request's own `Host` only when neither is set — and the configured ones.
 */
function allowedDomains(ctx: GoTrueContext, chain: Chain): Set<string> {
  const hosts = new Set([new URL(ctx.siteUrl).host]);
  for (const domain of ctx.options.web3?.[chain]?.domains ?? []) hosts.add(domain);
  return hosts;
}

/** GoTrue's request checks: the message's and the signature's size and encoding. */
function checkRequest(chain: Chain, text: unknown, signature: unknown): string {
  if (typeof text !== "string" || text.length < 64) throw refuse("message is too short");
  if (text.length > 20 * 1024) throw refuse("message must not exceed 20KB");
  if (chain === "ethereum") checkEthereumSignature(signature);
  else checkSolanaSignature(signature);
  return text;
}

function checkEthereumSignature(signature: unknown): void {
  if (typeof signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(signature)) return;
  throw refuse(
    "signature must be 65 bytes long, encoded as a 130 character-long hexadecimal string",
  );
}

function checkSolanaSignature(signature: unknown): void {
  if (typeof signature !== "string" || (signature.length !== 86 && signature.length !== 88)) {
    throw refuse("signature must be 64 bytes encoded as base64 with or without padding");
  }
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(signature)) {
    throw refuse("signature does not contain valid base64 characters");
  }
}

/** The message's shape (a parse error, as GoTrue's parser reports one). */
function checkShape(chain: Chain, message: Web3Message): void {
  if (message.chain !== chain) throw refuse("Message is for another chain");
  if (message.version !== "1") throw refuse("Unsupported message version");
  if (message.scheme !== undefined && !["https", "http"].includes(message.scheme)) {
    throw refuse("Unsupported scheme in the message");
  }
  checkFields(chain, message);
}

function checkFields(chain: Chain, message: Web3Message): void {
  if (message.nonce !== undefined && !/^[A-Za-z0-9]{8,128}$/.test(message.nonce)) {
    throw refuse("Message nonce must be 8 or more alphanumeric characters");
  }
  if (chain === "ethereum" && !/^[1-9][0-9]{0,15}$/.test(message.chainId ?? "")) {
    throw refuse("Message Chain ID is missing or invalid");
  }
}

/** The message's policy checks, GoTrue's `invalid_grant`s (after the signature). */
function checkPolicy(ctx: GoTrueContext, chain: Chain, message: Web3Message): void {
  const name = CHAIN_NAME[chain];
  checkUri(ctx, name, message.uri);
  if (!allowedDomains(ctx, chain).has(message.domain)) {
    throw new InvalidGrant(
      `Signed ${name} message is using a Domain that does not match the one in URI which is ` +
        "not allowed on this server",
    );
  }
  const allowed = ctx.options.web3?.ethereum?.chainIds;
  if (chain === "ethereum" && allowed?.length && !allowed.includes(Number(message.chainId))) {
    throw new InvalidGrant(`Signed ${name} message is using a Chain ID which is not allowed`);
  }
  checkTimes(ctx, name, message);
}

/** The message's URI: HTTPS (or localhost), and the site URL or an allowed redirect URL. */
function checkUri(ctx: GoTrueContext, name: string, raw: string): void {
  let uri: URL | undefined;
  try {
    uri = new URL(raw);
  } catch { /* refused below */ }
  if (!uri || (uri.protocol !== "https:" && uri.hostname !== "localhost")) {
    throw new InvalidGrant(`Signed ${name} message is using URI which does not use HTTPS`);
  }
  if (redirectTarget(ctx, uri.href) !== uri.href) {
    throw new InvalidGrant(
      `Signed ${name} message is using URI which is not allowed on this server, message was ` +
        "signed for another app",
    );
  }
}

function checkTimes(ctx: GoTrueContext, name: string, message: Web3Message): void {
  const now = Date.now();
  if (message.notBefore !== undefined && message.notBefore > now + SKEW * 1000) {
    throw new InvalidGrant(`Signed ${name} message becomes valid in the future`);
  }
  if (message.expirationTime !== undefined && message.expirationTime <= now) {
    throw new InvalidGrant(`Signed ${name} message is expired`);
  }
  if (now - message.issuedAt > maxAge(ctx.options) * 1000) {
    throw new InvalidGrant(`${name} message was issued too long ago`);
  }
  if (message.issuedAt > now + SKEW * 1000) {
    throw new InvalidGrant(`${name} message was issued too far in the future`);
  }
}

/** Claim the message's nonce (or the message itself) once. */
async function claimOnce(ctx: GoTrueContext, message: Web3Message, text: string): Promise<void> {
  const claim = ctx.adapter.claimWeb3Nonce;
  if (!claim) {
    throw new GoTrueError(500, "unexpected_failure", "the auth adapter keeps no Web3 nonces");
  }
  const key = message.nonce !== undefined
    ? `nonce:${message.chain}:${message.nonce}`
    : `message:${text}`;
  const expiresAt = Math.ceil(message.issuedAt / 1000) + maxAge(ctx.options) + SKEW;
  const fresh = await claim.call(ctx.adapter, await sha256Hex(`gotrue-web3:${key}`), expiresAt);
  if (!fresh) throw new InvalidGrant("Signed message has already been used");
}

function parse(text: string): Web3Message {
  try {
    return parseWeb3Message(text);
  } catch (error) {
    throw refuse(`Invalid sign-in message: ${(error as Web3Error).message}`);
  }
}

async function signatureValid(
  chain: Chain,
  message: Web3Message,
  text: string,
  signature: string,
): Promise<boolean> {
  return chain === "ethereum"
    ? verifyEthereum(message, text, signature)
    : await verifySolana(message, text, signature);
}

/** GoTrue's identity provider for every chain. */
const PROVIDER = "web3";

/** The user an address signs in as: its linked identity, or a new user. */
async function web3User(
  ctx: GoTrueContext,
  providerId: string,
  identityData: Record<string, unknown>,
): Promise<AdapterUser> {
  const linked = await ctx.adapter.getUserByAccount({
    provider: PROVIDER,
    providerAccountId: providerId,
  });
  if (linked) return linked;
  if (ctx.options.disableSignup) {
    throw new GoTrueError(422, "signup_disabled", "Signups not allowed for this instance");
  }
  const at = nowSeconds();
  return await ctx.adapter.createUser({
    userMetadata: { ...identityData },
    appMetadata: { provider: PROVIDER, providers: [PROVIDER] },
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * `POST /token?grant_type=web3`: `{ chain, message, signature }`. Refusals carry GoTrue's status
 * and shape: `422 web3_provider_disabled`, `400 web3_unsupported_chain`, `400 validation_failed`
 * for a malformed request or message, and `400 { error: "invalid_grant", error_description }`
 * for a signature or message that doesn't sign in here.
 *
 * @param ctx The context.
 * @param body The request body.
 * @returns The session, or the refusal.
 */
export async function web3Grant(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    return ok(await signIn(ctx, body));
  } catch (error) {
    if (!(error instanceof InvalidGrant)) throw error;
    return Response.json({ error: "invalid_grant", error_description: error.message }, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
}

/** The grant's checks, then the session. */
async function signIn(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
): Promise<GoTrueSessionJson> {
  const chain = enabledChain(ctx, body.chain);
  await checkCaptcha(ctx, body);
  await spendIp(ctx, signinStartLimiter(ctx.config), "web3");
  const text = checkRequest(chain, body.message, body.signature);
  const message = parse(text);
  checkShape(chain, message);
  if (!(await signatureValid(chain, message, text, body.signature as string))) {
    throw new InvalidGrant("Signature does not match address in message");
  }
  checkPolicy(ctx, chain, message);
  await claimOnce(ctx, message, text);
  return await startWeb3Session(ctx, chain, message);
}

/** The chain the request names, when Web3 and that chain are on. */
function enabledChain(ctx: GoTrueContext, chain: unknown): Chain {
  if (!ctx.options.web3) {
    throw new GoTrueError(422, "web3_provider_disabled", "Web3 provider is disabled");
  }
  if (chain !== "ethereum" && chain !== "solana") {
    throw new GoTrueError(400, "web3_unsupported_chain", "Unsupported chain");
  }
  if (!ctx.options.web3[chain]) {
    throw new GoTrueError(
      422,
      "web3_provider_disabled",
      `${CHAIN_NAME[chain]} Web3 provider is disabled`,
    );
  }
  return chain;
}

/** The user's `web3` identity (GoTrue's shape) and a session. */
async function startWeb3Session(
  ctx: GoTrueContext,
  chain: Chain,
  message: Web3Message,
): Promise<GoTrueSessionJson> {
  // GoTrue's shape: the address as the message writes it (supabase-js writes it lower-case).
  const providerId = `${PROVIDER}:${chain}:${message.address}`;
  const identityData = {
    sub: providerId,
    custom_claims: {
      address: message.address,
      chain,
      network: message.chainId ?? "",
      domain: message.domain,
      statement: message.statement ?? null,
    },
    email_verified: false,
    phone_verified: false,
  };
  const user = await web3User(ctx, providerId, identityData);
  await linkIdentity(ctx, user, {
    provider: PROVIDER,
    providerAccountId: providerId,
    identityData,
  });
  return await startSession(ctx.session, user, { method: "web3", timestamp: nowSeconds() });
}
