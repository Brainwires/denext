// Anonymous sign-in on denext's own endpoints (`anonymous: true`): `POST /anonymous`, the
// `isAnonymous` session user, conversion by an email or phone code from the anonymous session,
// what conversion never does (merge into an existing account, convert a pending session), and
// the `is_anonymous` claim a cookie session's queries run with.

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { denextAuth } from "../src/server/auth/mod.ts";
import { credentials, emailOtp, magicLink, phoneOtp } from "../src/server/auth/providers.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";
import { sessionClaims } from "../packages/backend/src/rls.ts";
import {
  call,
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

/** The stored anonymous user is untouched: still anonymous, no address, no number. */
async function assertStillAnonymous(h: NativeHarness, id: string) {
  const stored = await h.adapter.getUser(id);
  assertEquals([stored?.isAnonymous, stored?.email, stored?.phone], [true, undefined, undefined]);
  assert(!h.events.includes("userConverted"));
}

Deno.test("an email code issued outside the anonymous session signs in without converting it", async () => {
  const h = setup();
  const { cookie, session } = await anonymous(h);
  await post(h, "/auth/callback/email-otp", { email: "other@x.test" }); // no cookie
  const code = h.mail.at(-1)!.token;
  const done = await post(h, "/auth/callback/email-otp", { email: "other@x.test", code }, {
    cookie,
  });
  assertEquals(done.res.status, 200);
  assertNotEquals((await sessionOf(h, done.cookie))?.user.id, session.user.id);
  await assertStillAnonymous(h, session.user.id);
  const later = await proveEmail(h, "other@x.test");
  assertNotEquals((await sessionOf(h, later.cookie))?.user.id, session.user.id);
});

Deno.test("an email code issued outside the anonymous session is refused under allowSignUp: false", async () => {
  const h = setup({ providers: [emailOtp({ allowSignUp: false })] });
  const { cookie: other } = await anonymous(h);
  const { cookie, session } = await anonymous(h);
  // Requested from another anonymous session (so it is sent), redeemed from this one.
  await post(h, "/auth/callback/email-otp", { email: "other@x.test" }, { cookie: other });
  const code = h.mail.at(-1)!.token;
  const done = await post(h, "/auth/callback/email-otp", { email: "other@x.test", code }, {
    cookie,
  });
  assertEquals(done.res.status, 401);
  await assertStillAnonymous(h, session.user.id);
});

Deno.test("a magic link issued outside the anonymous session signs in without converting it", async () => {
  const h = setup({ providers: [magicLink({ confirm: false })] });
  const { cookie, session } = await anonymous(h);
  await post(h, "/auth/callback/email", { email: "other@x.test" }); // no cookie
  const link = new URL(h.mail.at(-1)!.url);
  const done = await call(h, "GET", link.pathname + link.search, undefined, { cookie });
  assertEquals(done.res.status, 303);
  assertNotEquals((await sessionOf(h, done.cookie))?.user.id, session.user.id);
  await assertStillAnonymous(h, session.user.id);
});

Deno.test("a magic link issued inside the anonymous session converts it", async () => {
  const h = setup({ providers: [magicLink({ confirm: false })] });
  const { cookie, session } = await anonymous(h);
  await post(h, "/auth/callback/email", { email: "mine@x.test" }, { cookie });
  const link = new URL(h.mail.at(-1)!.url);
  const done = await call(h, "GET", link.pathname + link.search, undefined, { cookie });
  assertEquals(done.res.status, 303);
  assertEquals((await sessionOf(h, done.cookie))?.user.id, session.user.id);
  const stored = await h.adapter.getUser(session.user.id);
  assertEquals([stored?.isAnonymous, stored?.email], [false, "mine@x.test"]);
});

Deno.test("a phone code issued outside the anonymous session signs in without converting it", async () => {
  const h = setup();
  const { cookie, session } = await anonymous(h);
  await post(h, "/auth/callback/phone", { phone: NUMBER }); // no cookie
  const code = h.sms.at(-1)!.otp;
  const done = await post(h, "/auth/callback/phone", { phone: NUMBER, code }, { cookie });
  assertEquals(done.res.status, 200);
  assertNotEquals((await sessionOf(h, done.cookie))?.user.id, session.user.id);
  await assertStillAnonymous(h, session.user.id);
  const later = await provePhone(h, NUMBER);
  assertNotEquals((await sessionOf(h, later.cookie))?.user.id, session.user.id);
});

Deno.test("a code issued for one anonymous session does not convert another", async () => {
  const h = setup();
  const first = await anonymous(h);
  const second = await anonymous(h);
  await post(h, "/auth/callback/email-otp", { email: "a@x.test" }, { cookie: first.cookie });
  const code = h.mail.at(-1)!.token;
  await post(h, "/auth/callback/email-otp", { email: "a@x.test", code }, {
    cookie: second.cookie,
  });
  await assertStillAnonymous(h, first.session.user.id);
  await assertStillAnonymous(h, second.session.user.id);
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
