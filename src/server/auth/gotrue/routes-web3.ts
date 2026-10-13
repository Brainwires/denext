/**
 * Web3 sign-in (`supabase.auth.signInWithWeb3()` → `POST /token?grant_type=web3`): a signed
 * Sign-In with Ethereum (EIP-4361) or Sign-In with Solana message becomes a session for the
 * user whose `web3:ethereum` / `web3:solana` identity is the signing address (created on first
 * sign-in unless sign-ups are disabled).
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
  redirectTarget,
  spendIp,
} from "./context.ts";
import { fail, GoTrueError } from "./errors.ts";
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

function refuse(message: string): GoTrueError {
  return new GoTrueError(400, "validation_failed", message);
}

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

/** Whether a URI is the site URL (or below it) or an allowed redirect URL. */
function allowedUri(ctx: GoTrueContext, uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return redirectTarget(ctx, url.href) === url.href;
}

/** The message's policy checks (everything but the signature and the nonce). */
function checkMessage(ctx: GoTrueContext, chain: Chain, message: Web3Message): void {
  if (message.chain !== chain) throw refuse("Message is for another chain");
  if (message.version !== "1") throw refuse("Unsupported message version");
  if (message.scheme !== undefined && !["https", "http"].includes(message.scheme)) {
    throw refuse("Unsupported scheme in the message");
  }
  if (!allowedDomains(ctx, chain).has(message.domain)) {
    throw refuse("Message domain is not allowed");
  }
  if (!allowedUri(ctx, message.uri)) throw refuse("Message URI is not allowed");
  if (message.nonce !== undefined && !/^[A-Za-z0-9]{8,128}$/.test(message.nonce)) {
    throw refuse("Message nonce must be 8 or more alphanumeric characters");
  }
  checkChainId(ctx, chain, message);
  checkTimes(ctx, message);
}

function checkChainId(ctx: GoTrueContext, chain: Chain, message: Web3Message): void {
  if (chain !== "ethereum") return;
  if (!message.chainId || !/^[1-9][0-9]{0,15}$/.test(message.chainId)) {
    throw refuse("Message Chain ID is missing or invalid");
  }
  const allowed = ctx.options.web3?.ethereum?.chainIds;
  if (allowed?.length && !allowed.includes(Number(message.chainId))) {
    throw refuse("Message Chain ID is not allowed");
  }
}

function checkTimes(ctx: GoTrueContext, message: Web3Message): void {
  const now = Date.now();
  if (message.issuedAt > now + SKEW * 1000) throw refuse("Message is issued in the future");
  if (now - message.issuedAt > maxAge(ctx.options) * 1000) throw refuse("Message has expired");
  if (message.expirationTime !== undefined && message.expirationTime <= now) {
    throw refuse("Message has expired");
  }
  if (message.notBefore !== undefined && message.notBefore > now + SKEW * 1000) {
    throw refuse("Message is not valid yet");
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
  if (!fresh) throw refuse("Signed message has already been used");
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
  signature: unknown,
): Promise<boolean> {
  if (typeof signature !== "string") return false;
  return chain === "ethereum"
    ? verifyEthereum(message, text, signature)
    : await verifySolana(message, text, signature);
}

/** The user an address signs in as: its linked identity, or a new user. */
async function web3User(
  ctx: GoTrueContext,
  provider: string,
  address: string,
  identityData: Record<string, unknown>,
): Promise<AdapterUser> {
  const linked = await ctx.adapter.getUserByAccount({ provider, providerAccountId: address });
  if (linked) return linked;
  if (ctx.options.disableSignup) {
    throw new GoTrueError(422, "signup_disabled", "Signups not allowed for this instance");
  }
  const at = nowSeconds();
  return await ctx.adapter.createUser({
    userMetadata: { ...identityData },
    appMetadata: { provider, providers: [provider] },
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * `POST /token?grant_type=web3`: `{ chain, message, signature }`.
 *
 * @param ctx The context.
 * @param body The request body.
 * @returns The session.
 */
export async function web3Grant(
  ctx: GoTrueContext,
  body: Record<string, unknown>,
): Promise<GoTrueSessionJson> {
  const chain = body.chain;
  if (chain !== "ethereum" && chain !== "solana" || !ctx.options.web3?.[chain]) {
    throw new GoTrueError(400, "provider_disabled", "Web3 provider is not enabled");
  }
  await checkCaptcha(ctx, body);
  await spendIp(ctx, signinStartLimiter(ctx.config), "web3");
  const text = body.message;
  if (typeof text !== "string" || text === "") throw fail.validation("message is required");
  const message = parse(text);
  checkMessage(ctx, chain, message);
  if (!(await signatureValid(chain, message, text, body.signature))) throw fail.credentials();
  await claimOnce(ctx, message, text);
  const provider = `web3:${chain}`;
  const address = chain === "ethereum" ? message.address.toLowerCase() : message.address;
  const identityData = {
    sub: `${provider}:${address}`,
    provider_id: address,
    address,
    chain: chain === "ethereum" ? `eip155:${message.chainId}` : message.chainId ?? "solana",
    domain: message.domain,
    ...(message.statement ? { statement: message.statement } : {}),
  };
  const user = await web3User(ctx, provider, address, identityData);
  await linkIdentity(ctx, user, { provider, providerAccountId: address, identityData });
  return await startSession(ctx.session, user, {
    method: "web3",
    timestamp: nowSeconds(),
    provider,
  });
}
