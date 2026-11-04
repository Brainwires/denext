// The OAuth sign-in harness shared by the flow tests: run the auth routes in a request context,
// read the transaction cookie, an RS256 identity provider, and start / finish a sign-in.

import { assert, assertEquals } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../../src/server/request-context.ts";
import { handleAuthRequest } from "../../packages/auth/src/routes.ts";
import { base64UrlEncode } from "../../packages/auth/src/oauth.ts";
import type { AuthConfig, OAuthProvider } from "../../packages/auth/src/types.ts";

export const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
const TX = "__Host-denext_auth_tx";

/** Run the auth routes on `request` in a fresh request context. */
async function run(request: Request, config: AuthConfig) {
  const ctx: RequestContext = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  assert(res);
  return { res, ctx };
}

/** The transaction cookie a response set, as `name=value`. */
function txPair(ctx: RequestContext): string {
  return ctx.outgoingHeaders.getSetCookie().find((c) =>
    c.startsWith(`${TX}=`) && !c.startsWith(`${TX}=;`)
  )!.split(";")[0];
}

/** The signed transaction cookie's payload. */
export function txData(pair: string): { nonce?: string; state: string; verifier: string } {
  const b64 = pair.split("=")[1].split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), (c) => c.charCodeAt(0)),
  );
  return JSON.parse(json).d;
}

/** An RS256 identity provider: its JWKS and an id_token minter. */
export async function makeIdp() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = crypto.randomUUID();
  const jwks = { keys: [{ kty: "RSA", kid, n: pub.n, e: pub.e, alg: "RS256" }] };
  const mint = async (claims: Record<string, unknown>): Promise<string> => {
    const seg = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
    const signing = `${seg({ alg: "RS256", typ: "JWT", kid })}.${seg(claims)}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(signing),
    );
    return `${signing}.${base64UrlEncode(new Uint8Array(sig))}`;
  };
  return { jwks, mint };
}

/** An identity provider from {@linkcode makeIdp}. */
export type Idp = Awaited<ReturnType<typeof makeIdp>>;

export function appConfig(provider: OAuthProvider, failures: string[] = []): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    dangerouslyAllowInsecureProviders: true,
    providers: [provider],
    pages: { signIn: "/login" },
    events: { signInFailed: ({ reason }) => void failures.push(reason) },
  };
}

/** Start a sign-in: the authorization URL and the transaction cookie. */
export async function start(config: AuthConfig, id: string) {
  const { res, ctx } = await run(new Request(`${ORIGIN}/auth/signin/${id}`), config);
  assertEquals(res.status, 303);
  return { authorize: new URL(res.headers.get("location")!), pair: txPair(ctx) };
}

/** The callback for a started sign-in. */
export async function callback(config: AuthConfig, id: string, pair: string, state: string) {
  const { res } = await run(
    new Request(`${ORIGIN}/auth/callback/${id}?code=the-code&state=${state}`, {
      headers: { cookie: pair },
    }),
    config,
  );
  return res;
}

/** Whether a callback signed in (landing on `/`). */
export function signedIn(res: Response): boolean {
  return res.status === 303 && res.headers.get("location") === "/";
}
