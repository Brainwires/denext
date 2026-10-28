// Anonymous sign-in on denext's own endpoints (`anonymous: true`): `POST /anonymous`, the
// `isAnonymous` session user, conversion by an email or phone code from the anonymous session,
// what conversion never does (merge into an existing account, convert a pending session), and
// the `is_anonymous` claim a cookie session's queries run with.

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { denextAuth } from "../packages/auth/src/mod.ts";
import { credentials, emailOtp, phoneOtp } from "../packages/auth/src/providers.ts";
import type { AuthConfig, AuthSession } from "../packages/auth/src/types.ts";
import { sessionClaims } from "../packages/backend/src/rls.ts";
import {
  type NativeHarness,
  nativeHarness,
  post,
  SECRET,
  sessionOf,
  visible,
} from "./helpers/auth-native-harness.ts";

const NUMBER = "+15550100009";

function setup(extra: Partial<AuthConfig> = {}): NativeHarness {
  return nativeHarness({ providers: [emailOtp(), phoneOtp()], anonymous: true, ...extra });
}

/** Sign in anonymously; the session cookie and the session. */
async function anonymous(h: NativeHarness): Promise<{ cookie: string; session: AuthSession }> {
  const { res, cookie } = await post(h, "/auth/anonymous", {});
  assertEquals(res.status, 200);
  const session = await sessionOf(h, cookie);
  assert(cookie && session);
  return { cookie, session };
}

/** Prove `email` with an emailed code, presenting `cookie`. */
async function proveEmail(h: NativeHarness, email: string, cookie?: string) {
  await post(h, "/auth/callback/email-otp", { email }, { cookie });
  const code = h.mail.at(-1)!.token;
  return await post(h, "/auth/callback/email-otp", { email, code }, { cookie });
}

/** Prove `phone` with a texted code, presenting `cookie`. */
async function provePhone(h: NativeHarness, phone: string, cookie?: string) {
  await post(h, "/auth/callback/phone", { phone }, { cookie });
  const code = h.sms.at(-1)!.otp;
  return await post(h, "/auth/callback/phone", { phone, code }, { cookie });
}

Deno.test("POST /anonymous does not exist without anonymous: true", async () => {
  const h = setup({ anonymous: undefined });
  assertEquals((await post(h, "/auth/anonymous", {})).res.status, 404);
});

Deno.test("POST /anonymous creates an identifier-less user and signs it in (amr anonymous, isAnonymous)", async () => {
  const h = setup();
  const { session } = await anonymous(h);
  assertEquals([session.provider, session.amr, session.user.isAnonymous], [
    "anonymous",
    ["anonymous"],
    true,
  ]);
  const stored = await h.adapter.getUser(session.user.id);
  assertEquals([stored?.isAnonymous, stored?.email, stored?.phone], [true, undefined, undefined]);
  assertEquals(h.events, ["createUser", "signIn"]);
  assertEquals(sessionClaims(session).is_anonymous, true);

  const form = await post(h, "/auth/anonymous", {}, { form: true });
  assertEquals(await visible(form.res), [303, "/home", ""]);
  const foreign = await post(h, "/auth/anonymous", {}, { origin: "https://evil.test" });
  assertEquals(foreign.res.status, 403);
});

Deno.test("POST /anonymous spends the per-IP sign-in-start budget", async () => {
  const h = setup({ rateLimit: { signin: { max: 2 } } });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await post(h, "/auth/anonymous", {})).res.status);
  assertEquals(statuses, [200, 200, 429]);
  assertEquals(h.events.at(-1), "signInFailed:rate_limited");
});

Deno.test("conversion by email code keeps the user id and clears isAnonymous", async () => {
  const h = setup();
  const { cookie, session } = await anonymous(h);
  const done = await proveEmail(h, "new@x.test", cookie);
  assertEquals(done.res.status, 200);
  const after = await sessionOf(h, done.cookie);
  assertEquals([after?.user.id, after?.user.isAnonymous, after?.user.email], [
    session.user.id,
    undefined,
    "new@x.test",
  ]);
  const stored = await h.adapter.getUser(session.user.id);
  assertEquals([stored?.isAnonymous, stored?.email], [false, "new@x.test"]);
  assertEquals(typeof stored?.emailVerified, "number");
  assertEquals(h.events.slice(2), ["userConverted", "signIn"]);
  assertEquals(sessionClaims(after!).is_anonymous, false);
});

Deno.test("conversion by phone code keeps the user id — even under allowSignUp: false", async () => {
  const h = setup({ providers: [phoneOtp({ allowSignUp: false })] });
  const { cookie, session } = await anonymous(h);
  const done = await provePhone(h, NUMBER, cookie);
  assertEquals(done.res.status, 200);
  assertEquals((await sessionOf(h, done.cookie))?.user.id, session.user.id);
  const stored = await h.adapter.getUser(session.user.id);
  assertEquals([stored?.isAnonymous, stored?.phone], [false, NUMBER]);
  assertEquals(typeof stored?.phoneVerified, "number");

  // Without an anonymous session the same provider texts a stranger nothing.
  const texts = h.sms.length;
  await post(h, "/auth/callback/phone", { phone: "+15550100010" });
  assertEquals(h.sms.length, texts);
});

Deno.test("an address that already has an account signs into it; the anonymous user is left alone", async () => {
  const h = setup();
  const owner = await h.adapter.createUser({ email: "owner@x.test", emailVerified: 1 });
  const { cookie, session } = await anonymous(h);
  const done = await proveEmail(h, "owner@x.test", cookie);
  assertEquals((await sessionOf(h, done.cookie))?.user.id, owner.id);
  assertEquals((await h.adapter.getUser(session.user.id))?.isAnonymous, true);
  assert(!h.events.includes("userConverted"));
});

Deno.test("a pending (MFA-owed) anonymous session never converts", async () => {
  const h = setup({ mfa: { required: "always" } });
  const { cookie, session } = await anonymous(h);
  assertEquals(session.mfaPending, true);
  const done = await proveEmail(h, "fresh@x.test", cookie);
  const after = await sessionOf(h, done.cookie);
  assertNotEquals(after?.user.id, session.user.id, "a new user, not the anonymous one");
  assertEquals((await h.adapter.getUser(session.user.id))?.isAnonymous, true);
  assert(!h.events.includes("userConverted"));
});

Deno.test("denextAuth: anonymous: true without an adapter is refused at construction", () => {
  const config: AuthConfig = {
    secret: SECRET,
    canonicalOrigin: "https://app.test",
    providers: [credentials({ authorize: () => null })],
    anonymous: true,
  };
  assertThrows(() => denextAuth(config), Error, "anonymous: true");
});
