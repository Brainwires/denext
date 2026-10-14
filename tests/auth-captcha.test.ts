// Captcha (`captcha`) on denext's own endpoints: the credentials sign-in, the email and phone
// SENDS, `POST /anonymous` and `POST /reset` refuse a request without a token the provider
// confirms — before any budget or adapter work — while the redeems need none; and the shared
// `verifyCaptcha` treats every provider failure as "no".

import { assert, assertEquals } from "@std/assert";
import { verifyCaptcha } from "../src/server/auth/captcha.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { credentials, emailOtp, phoneOtp } from "../src/server/auth/providers.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { type NativeHarness, nativeHarness, post, visible } from "./helpers/auth-native-harness.ts";

/** A fake provider: `good` is solved, anything else is not; every call is recorded. */
function fakeProvider() {
  const calls: URLSearchParams[] = [];
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    calls.push(form);
    return Promise.resolve(Response.json({ success: form.get("response") === "good" }));
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

async function setup(extra: Partial<AuthConfig> = {}) {
  const provider = fakeProvider();
  const h = nativeHarness({
    providers: [credentials(), emailOtp(), phoneOtp()],
    anonymous: true,
    captcha: { provider: "turnstile", secret: "captcha-secret", fetch: provider.fetch },
    ...extra,
  });
  const user = await h.adapter.createUser({ email: "member@x.test", emailVerified: 1 });
  await h.adapter.setCredential!(
    user.id,
    await resolveAuthOptions(h.config).hasher.hash("correct-password"),
  );
  return { h, provider };
}

/** Each protected endpoint, and a body that would succeed past the captcha. */
const PROTECTED: [string, string, Record<string, string>][] = [
  ["credentials sign-in", "/auth/callback/credentials", {
    email: "member@x.test",
    password: "correct-password",
  }],
  ["email send", "/auth/callback/email-otp", { email: "member@x.test" }],
  ["phone send", "/auth/callback/phone", { phone: "+15550100001" }],
  ["anonymous sign-in", "/auth/anonymous", {}],
  ["password-reset request", "/auth/reset", { email: "member@x.test" }],
];

const REFUSED = JSON.stringify({ error: "captcha_failed" });

Deno.test("every protected endpoint refuses without a token, refuses a bad one, and accepts a good one", async () => {
  for (const [name, path, body] of PROTECTED) {
    const { h, provider } = await setup();
    assertEquals(await visible((await post(h, path, body)).res), [400, null, REFUSED], name);
    assertEquals(provider.calls.length, 0, `${name}: no token, no provider call`);
    const bad = await post(h, path, { ...body, captchaToken: "bad" });
    assertEquals(await visible(bad.res), [400, null, REFUSED], name);
    assertEquals(h.mail.length + h.sms.length, 0, `${name}: nothing sent`);
    const good = await post(h, path, { ...body, captchaToken: "good" });
    assertEquals(good.res.status, 200, name);
    const call = provider.calls.at(-1)!;
    assertEquals(
      [call.get("secret"), call.get("response"), call.get("remoteip")],
      ["captcha-secret", "good", "203.0.113.9"],
      name,
    );
  }
});

Deno.test("a form post is sent to the error page with ?error=CaptchaFailed", async () => {
  const { h } = await setup();
  const res = await post(h, "/auth/callback/email-otp", { email: "member@x.test" }, { form: true });
  assertEquals(await visible(res.res), [303, "/oops?error=CaptchaFailed", ""]);
  const noErrorPage = (await setup({ pages: { signIn: "/login" } })).h;
  const fallback = await post(noErrorPage, "/auth/reset", { email: "a@x.test" }, { form: true });
  assertEquals(fallback.res.headers.get("location"), "/login?error=CaptchaFailed");
});

Deno.test("the token may come from each widget's field or the x-captcha-token header", async () => {
  for (const field of ["captcha_token", "cf-turnstile-response", "h-captcha-response"]) {
    const { h } = await setup();
    const res = await post(h, "/auth/anonymous", { [field]: "good" }, { form: true });
    assertEquals(res.res.status, 303, field);
  }
  const { h } = await setup();
  const header = await post(h, "/auth/anonymous", {}, { headers: { "x-captcha-token": "good" } });
  assertEquals(header.res.status, 200);
});

Deno.test("a sign-in refusal fires signInFailed: captcha_failed; refusals spend no budget", async () => {
  const { h } = await setup();
  for (let i = 0; i < 12; i++) {
    await post(h, "/auth/callback/email-otp", { email: "member@x.test", captchaToken: "bad" });
  }
  assertEquals(h.events.filter((e) => e === "signInFailed:captcha_failed").length, 12);
  const ok = await post(h, "/auth/callback/email-otp", {
    email: "member@x.test",
    captchaToken: "good",
  });
  assertEquals(ok.res.status, 200, "the send budget (3) was never touched by the refusals");
  assertEquals(h.mail.length, 1);

  const reset = await setup();
  await post(reset.h, "/auth/reset", { email: "member@x.test" });
  assert(!reset.h.events.some((e) => e.startsWith("signInFailed")), "a reset is no sign-in");
});

Deno.test("the redeems need no token: an email code and a phone code sign in under captcha", async () => {
  const { h } = await setup();
  await post(h, "/auth/callback/email-otp", { email: "member@x.test", captchaToken: "good" });
  const email = await post(h, "/auth/callback/email-otp", {
    email: "member@x.test",
    code: h.mail[0].token,
  });
  assertEquals(email.res.status, 200);
  await post(h, "/auth/callback/phone", { phone: "+15550100001", captchaToken: "good" });
  const phone = await post(h, "/auth/callback/phone", {
    phone: "+15550100001",
    code: h.sms[0].otp,
  });
  assertEquals(phone.res.status, 200);
});

Deno.test("verifyCaptcha: a provider error, a non-2xx answer or a throw is false (logged)", async () => {
  const logged: string[] = [];
  const logger = { error: (message: string) => void logged.push(message) };
  const answer = (response: Response) => () => Promise.resolve(response);
  const base = { provider: "hcaptcha" as const, secret: "s" };
  assertEquals(
    await verifyCaptcha(
      { ...base, fetch: answer(Response.json({ success: true })) },
      "t",
      "1.2.3.4",
    ),
    true,
  );
  assertEquals(
    await verifyCaptcha({
      ...base,
      fetch: answer(Response.json({ success: true }, { status: 500 })),
    }, "t"),
    false,
  );
  assertEquals(
    await verifyCaptcha(
      { ...base, fetch: answer(new Response("not json")) },
      "t",
      undefined,
      logger,
    ),
    false,
  );
  const thrower = () => Promise.reject(new Error("offline"));
  assertEquals(await verifyCaptcha({ ...base, fetch: thrower }, "t", undefined, logger), false);
  assertEquals(logged, ["captcha verification failed", "captcha verification failed"]);
});

Deno.test("without captcha configured nothing changes", async () => {
  const h: NativeHarness = nativeHarness({ providers: [emailOtp()], anonymous: true });
  assertEquals((await post(h, "/auth/anonymous", {})).res.status, 200);
  assertEquals((await post(h, "/auth/callback/email-otp", { email: "a@x.test" })).res.status, 200);
});
