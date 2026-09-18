// One mailbox, one account, whichever way its internationalised domain is spelled.
//
// The emailed flows always keyed `a@bücher.de` as `a@xn--bcher-kva.de` (what SMTP carries);
// the credentials lookup, the OAuth email match and both adapters only trimmed and
// lower-cased. So an account registered by password was a SECOND account to a magic link,
// and a password reset never found it. Every path now goes through one `emailKey`.

import { assert, assertEquals } from "@std/assert";
import { emailKey } from "../src/server/auth/email-key.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import type { AuthConfig, CredentialsProvider } from "../src/server/auth/types.ts";
import { normalizeEmailIdentifier } from "../src/server/auth/verification.ts";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";
/** What a person types. */
const TYPED = "Ada@Bücher.de";
/** What SMTP carries — and what a magic link or a reset token is issued for. */
const MAILED = "ada@xn--bcher-kva.de";

/** A Credentials provider with no `authorize` — the adapter-backed default. */
const DEFAULT_PROVIDER: CredentialsProvider = { id: "credentials", type: "credentials" };

Deno.test("emailKey: trim, case-fold, and punycode the domain — the local part as is", () => {
  assertEquals(emailKey(`  ${TYPED}  `), MAILED);
  assertEquals(emailKey(MAILED), MAILED, "already ASCII: unchanged");
  assertEquals(emailKey("Ada@X.Test"), "ada@x.test");
  // Total, unlike the validating normaliser: a store still needs a key for a bad address.
  assertEquals(emailKey("not an address"), "not an address");
  assertEquals(emailKey("a@b c.de"), "a@b c.de");
  assertEquals(normalizeEmailIdentifier("a@b c.de"), null);
  // And the two agree on every address the validator accepts.
  assertEquals(normalizeEmailIdentifier(TYPED), emailKey(TYPED));
});

Deno.test("inMemoryAuthAdapter: an internationalised domain is one address in either spelling", async () => {
  const adapter = inMemoryAuthAdapter();
  const ada = await adapter.createUser({ email: TYPED });
  assertEquals((await adapter.getUserByEmail(MAILED))?.id, ada.id, "found as mailed");
  assertEquals((await adapter.getUserByEmail(" ada@bücher.de "))?.id, ada.id, "found as typed");
  assertEquals((await adapter.getUser(ada.id))?.email, TYPED, "stored as given");
  let refused = false;
  try {
    await adapter.createUser({ email: MAILED });
  } catch {
    refused = true;
  }
  assert(refused, "the punycode spelling is the same account, not a second one");

  const grace = await adapter.createUser({ email: "grace@xn--mnchen-3ya.de" });
  assertEquals((await adapter.getUserByEmail("Grace@München.de"))?.id, grace.id);
  // Re-keying on update follows the same rule.
  await adapter.updateUser({ id: grace.id, email: "grace@zürich.ch" });
  assertEquals((await adapter.getUserByEmail("grace@xn--zrich-kva.ch"))?.id, grace.id);
  assertEquals(await adapter.getUserByEmail("grace@münchen.de"), undefined, "the old key is gone");
});

// ---- the credentials sign-in path ----------------------------------------------

/** POST the credentials callback exactly as the rendered sign-in form would. */
async function login(
  config: AuthConfig,
  body: Record<string, string>,
): Promise<{ res: Response; ctx: RequestContext }> {
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams(body).toString(),
  });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  return { res: res!, ctx };
}

/** Whether a response issued the session cookie. */
function signedIn(ctx: RequestContext): boolean {
  return ctx.outgoingHeaders.getSetCookie().some((c) => c.startsWith("__Host-denext_auth="));
}

Deno.test("credentials sign-in: the account a magic link created for the mailed spelling signs in as typed", async () => {
  const adapter = inMemoryAuthAdapter();
  // What the emailed flows create: `createUser({ email: identifier })`, identifier punycoded.
  const user = await adapter.createUser({ email: MAILED, emailVerified: 1 });
  await adapter.setCredential!(user.id, await hashPassword("correct horse"));
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [DEFAULT_PROVIDER],
    adapter,
    logger: { error: () => {} },
  };

  const typed = await login(config, { email: `  ${TYPED} `, password: "correct horse" });
  assertEquals(typed.res.status, 303, "the form post is answered with the redirect of a sign-in");
  assert(signedIn(typed.ctx), "typed with the Unicode domain: signed in");

  const mailed = await login(config, { email: MAILED, password: "correct horse" });
  assertEquals(mailed.res.status, 303);
  assert(signedIn(mailed.ctx), "typed with the punycode domain: signed in");

  const wrong = await login(config, { email: TYPED, password: "nope" });
  assertEquals(wrong.res.status, 401, "and the password is still what decides it");
  assert(!signedIn(wrong.ctx));
});

Deno.test("credentials sign-in: an account registered as typed is the one a mailed-spelling login finds", async () => {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: TYPED });
  await adapter.setCredential!(user.id, await hashPassword("pw"));
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [DEFAULT_PROVIDER],
    adapter,
    logger: { error: () => {} },
  };
  const { res, ctx } = await login(config, { email: MAILED, password: "pw" });
  assertEquals(res.status, 303);
  assert(signedIn(ctx));
});
