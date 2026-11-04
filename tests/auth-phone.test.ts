// Passwordless phone sign-in — `phoneOtp()`: the send (E.164, one number, enumeration-safe,
// the send budget), the redeem (single use, the failure budget, sign-up vs `allowSignUp:
// false`), the pre-account-hijacking eviction for an unverified number, the MFA step-up, the
// config-time check, `GET /providers`, and the dispatcher's 405 / cross-origin 403.

import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { denextAuth } from "../packages/auth/src/mod.ts";
import { issueApiToken } from "../packages/auth/src/api-token.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { resolveAuthOptions } from "../packages/auth/src/options.ts";
import { normalizePhoneNumber } from "../packages/auth/src/phone.ts";
import { credentials, phoneOtp } from "../packages/auth/src/providers.ts";
import { assertPhoneProviderConfig } from "../packages/auth/src/providers-phone.ts";
import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { type AuthConfig, isPhoneProvider } from "../packages/auth/src/types.ts";
import {
  call,
  type CallInit,
  type NativeHarness,
  nativeHarness,
  post,
  SECRET,
  sessionOf,
  visible,
} from "./helpers/auth-native-harness.ts";

const PATH = "/auth/callback/phone";
const NUMBER = "+15550100001";

function setup(extra: Partial<AuthConfig> = {}, provider = phoneOtp()): NativeHarness {
  return nativeHarness({ providers: [provider, credentials()], ...extra });
}

const send = (h: NativeHarness, phone: string, init: CallInit = {}) =>
  post(h, PATH, { phone }, init);
const redeem = (h: NativeHarness, phone: string, code: string, init: CallInit = {}) =>
  post(h, PATH, { phone, code }, init);
const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";

Deno.test("phoneOtp: defaults and overrides; GET /providers echoes { id, name, type }", async () => {
  assertEquals(phoneOtp(), { id: "phone", name: "Phone code", type: "phone", allowSignUp: true });
  assertEquals(phoneOtp({ id: "sms", name: "Text me", allowSignUp: false }), {
    id: "sms",
    name: "Text me",
    type: "phone",
    allowSignUp: false,
  });
  assert(isPhoneProvider(phoneOtp()) && !isPhoneProvider(credentials()));
  const h = setup();
  const res = await call(h, "GET", "/auth/providers");
  assertEquals(await res.res.json(), [
    { id: "phone", name: "Phone code", type: "phone" },
    { id: "credentials", type: "credentials" },
  ]);
});

Deno.test("normalizePhoneNumber: E.164 or nothing", () => {
  assertEquals(normalizePhoneNumber("+1 (555) 010-0001"), NUMBER);
  assertEquals(normalizePhoneNumber("1.555.010.0001"), NUMBER);
  for (
    const bad of [
      "",
      "+0123456789",
      "+1555",
      "+1555010000155555",
      "+1555 ext 2",
      42,
      "a".repeat(80),
    ]
  ) {
    assertEquals(normalizePhoneNumber(bad), null, String(bad));
  }
});

Deno.test("assertPhoneProviderConfig / denextAuth: an SMS sender and the adapter groups are required", () => {
  const ok: AuthConfig = {
    secret: SECRET,
    providers: [phoneOtp()],
    adapter: inMemoryAuthAdapter(),
    sendSms: () => {},
  };
  assertPhoneProviderConfig(ok);
  assertPhoneProviderConfig({ ...ok, sendSms: undefined, hooks: { sendSms: () => {} } });
  assertPhoneProviderConfig({
    secret: SECRET,
    providers: [credentials({ authorize: () => null })],
  });
  assertThrows(() => assertPhoneProviderConfig({ ...ok, sendSms: undefined }), Error, "sendSms");
  assertThrows(
    () => assertPhoneProviderConfig({ ...ok, adapter: undefined }),
    Error,
    "none is configured",
  );
  const { getUserByPhone: _p, ...phoneless } = inMemoryAuthAdapter();
  assertThrows(
    () => assertPhoneProviderConfig({ ...ok, adapter: phoneless as AuthAdapter }),
    Error,
    "getUserByPhone",
  );
  assertThrows(() => denextAuth({ ...ok, sendSms: undefined }), Error, "sendSms");
  assertEquals(denextAuth({ ...ok, canonicalOrigin: "https://app.test" }).name, "denext-auth");
});

Deno.test("send + redeem: the code is texted, signs a new user up phone-verified, and is single-use", async () => {
  const h = setup();
  const sent = await send(h, "+1 (555) 010-0001");
  assertEquals(await visible(sent.res), [200, null, JSON.stringify({ ok: true })]);
  assertEquals(h.sms.length, 1);
  const [message] = h.sms;
  assertEquals(
    [message.phone, message.channel, message.type, message.message],
    [NUMBER, "sms", "sms", `Your code is ${message.otp}`],
  );
  assertEquals(message.otp.length, 6);
  assertEquals(message.user, undefined, "no account yet");

  const done = await redeem(h, NUMBER, message.otp.replace(/^(...)/, "$1 "));
  assertEquals(done.res.status, 200);
  const body = await done.res.json();
  assertEquals(body.ok, true);
  const session = await sessionOf(h, done.cookie);
  assertEquals([session?.provider, session?.amr], ["phone", ["sms"]]);
  const user = await h.adapter.getUserByPhone!(NUMBER);
  assert(user && typeof user.phoneVerified === "number");
  assertEquals(session?.user.id, user.id);
  assertEquals(h.events, ["createUser", "signIn"]);

  const replay = await redeem(h, NUMBER, message.otp);
  assertEquals(await visible(replay.res), [401, null, JSON.stringify({ error: "invalid code" })]);
  assertEquals(replay.cookie, undefined);
});

Deno.test("send: known, unknown and invalid numbers get the identical answer; allowSignUp: false texts no stranger", async () => {
  const h = setup({}, phoneOtp({ allowSignUp: false }));
  await h.adapter.createUser({ phone: NUMBER, phoneVerified: 1 });
  const known = await visible((await send(h, NUMBER)).res);
  assertEquals(await visible((await send(h, "+15550100002")).res), known);
  assertEquals(await visible((await send(h, "not a number")).res), known);
  const knownForm = await visible((await send(h, NUMBER, { form: true })).res);
  assertEquals(knownForm, [303, "/check?sent=1", ""]);
  assertEquals(await visible((await send(h, "+15550100002", { form: true })).res), knownForm);
  assertEquals(h.sms.map((m) => m.phone), [NUMBER, NUMBER], "only the member got texts");
  assertEquals(h.sms[0].user?.phone, NUMBER, "the sender sees the account");

  // A code for the stranger can't sign anyone up.
  const refused = await redeem(h, "+15550100002", "123456");
  assertEquals(refused.res.status, 401);
  assertEquals(await h.adapter.getUserByPhone!("+15550100002"), undefined);
});

Deno.test("send budget: the 4th send for one number is the same 429 whether or not it exists", async () => {
  const h = setup({}, phoneOtp({ allowSignUp: false }));
  await h.adapter.createUser({ phone: NUMBER, phoneVerified: 1 });
  const run = async (phone: string, peer: string) => {
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push((await send(h, phone, { peer })).res.status);
    return out;
  };
  assertEquals(await run(NUMBER, "198.51.100.1"), [200, 200, 200, 429]);
  assertEquals(await run("+15550100002", "198.51.100.2"), [200, 200, 200, 429]);
});

Deno.test("redeem: every wrong code is the same 401 and counts; the 6th attempt is a 429 (form: ?error=Verification)", async () => {
  const h = setup();
  await send(h, NUMBER);
  const code = h.sms[0].otp;
  const answers = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const { res } = await redeem(h, NUMBER, wrongCode(code));
    answers.add(`${res.status} ${await res.text()}`);
  }
  assertEquals([...answers], [`401 ${JSON.stringify({ error: "invalid code" })}`]);
  const locked = await redeem(h, NUMBER, code);
  assertEquals(locked.res.status, 429);
  assertEquals(locked.cookie, undefined);
  const elsewhere = await redeem(h, NUMBER, code, { peer: "198.51.100.4" });
  assertEquals(elsewhere.res.status, 429, "the budget is per number, not only per IP");
  assertEquals(h.events.filter((e) => e === "signInFailed:invalid_credentials").length, 5);

  const form = setup();
  const refused = await redeem(form, NUMBER, "123456", { form: true });
  assertEquals(await visible(refused.res), [303, "/oops?error=Verification", ""]);
});

Deno.test("an existing user with an unverified number: the password, factors, passkeys and tokens are retired first", async () => {
  const h = setup({ session: { strategy: "database" } });
  const user = await h.adapter.createUser({ phone: NUMBER, email: "victim@x.test" });
  const hasher = resolveAuthOptions(h.config).hasher;
  await h.adapter.setCredential!(user.id, await hasher.hash("attacker-password"));
  await h.adapter.setMfa!({
    userId: user.id,
    secret: "JBSWY3DPEHPK3PXP",
    confirmedAt: 1,
    backupCodeHashes: [],
  });
  await h.adapter.createPasskey!({
    id: "cred-1",
    userId: user.id,
    publicKey: "pk",
    alg: -7,
    signCount: 0,
    backupEligible: false,
    backedUp: false,
    createdAt: 1,
  });
  await issueApiToken(h.config, { userId: user.id, name: "persistence" });

  await send(h, NUMBER);
  const done = await redeem(h, NUMBER, h.sms[0].otp);
  assertEquals((await done.res.json()).ok, true);
  const session = await sessionOf(h, done.cookie);
  assertEquals([session?.user.id, session?.mfaPending], [user.id, undefined], "no MFA step");
  const stored = await h.adapter.getUser(user.id);
  assertEquals(typeof stored?.phoneVerified, "number");
  assertEquals(await h.adapter.getMfa!(user.id), undefined);
  assertEquals(await h.adapter.listPasskeys!(user.id), []);
  assertEquals(await h.adapter.listApiTokens!(user.id), []);
  const password = await h.adapter.getCredential!(user.id);
  assert(!password || !(await hasher.verify("attacker-password", password)));
  assert(h.events.includes("apiTokenRevoked:phone_verified"));
  assertEquals(h.events.slice(-2), ["phoneVerified", "signIn"]);
});

Deno.test("an MFA-enrolled user with a verified number gets a pending session", async () => {
  const h = setup();
  const user = await h.adapter.createUser({ phone: NUMBER, phoneVerified: 1 });
  await h.adapter.setMfa!({
    userId: user.id,
    secret: "JBSWY3DPEHPK3PXP",
    confirmedAt: 1,
    backupCodeHashes: [],
  });
  await send(h, NUMBER);
  const done = await redeem(h, NUMBER, h.sms[0].otp);
  assertEquals(await done.res.json(), { ok: true, mfa: "required" });
  assertEquals((await sessionOf(h, done.cookie))?.mfaPending, true);
  assertEquals(h.events, []);
  assertNotEquals(
    await h.adapter.getMfa!(user.id),
    undefined,
    "a verified number keeps its factor",
  );
});

Deno.test("the dispatcher: GET is a 405 (a code never rides a URL); a cross-origin POST is a 403", async () => {
  const h = setup();
  assertEquals((await call(h, "GET", `${PATH}?phone=${NUMBER}&code=123456`)).res.status, 405);
  const foreign = await send(h, NUMBER, { origin: "https://evil.test" });
  assertEquals(await visible(foreign.res), [403, null, JSON.stringify({ error: "forbidden" })]);
  assertEquals(h.sms, []);
});

Deno.test("hooks.sendSms carries the phone sign-in code instead of sendSms", async () => {
  const hooked: string[] = [];
  const h = setup({
    hooks: { sendSms: ({ phone, type }) => void hooked.push(`${type}:${phone}`) },
  });
  await send(h, NUMBER);
  assertEquals([hooked, h.sms], [[`sms:${NUMBER}`], []]);
});

Deno.test("a failing SMS sender is logged without the code and changes nothing in the answer", async () => {
  const logged: string[] = [];
  const h = setup({
    sendSms: () => {
      throw new Error("gateway down");
    },
    logger: { error: (message) => void logged.push(message) },
  });
  const res = await send(h, NUMBER);
  assertEquals(await visible(res.res), [200, null, JSON.stringify({ ok: true })]);
  assertEquals(logged, ['denextAuth: sending a "sms" SMS failed']);
});
