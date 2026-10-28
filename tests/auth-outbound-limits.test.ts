// Every outbound send on denext's own endpoints (an email code / link, a password-reset mail,
// a phone sign-in code) sits behind BOTH a per-identifier budget and a per-client-address one,
// spent before the mailer / SMS gateway is called: a counting fake sender proves a burst from
// one address reaches the provider at most budget-many times, whatever identifiers it names.

import { assertEquals } from "@std/assert";
import { emailOtp, phoneOtp } from "../packages/auth/src/providers.ts";
import { nativeHarness, post } from "./helpers/auth-native-harness.ts";

/** The per-address send budget (3) times the IP-wide factor (10). */
const IP_SENDS = 30;

/** POST each body to `path` from `peer`; the statuses. */
async function sendAll(
  h: ReturnType<typeof nativeHarness>,
  path: string,
  bodies: Record<string, string>[],
  peer = "203.0.113.9",
): Promise<number[]> {
  const statuses: number[] = [];
  for (const body of bodies) statuses.push((await post(h, path, body, { peer })).res.status);
  return statuses;
}

const emails = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `u${i}@x.test` }));
const phones = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ phone: `+1555010${String(i).padStart(4, "0")}` }));

Deno.test("email-code sends: one address can't drive more than the IP-wide budget, across identifiers", async () => {
  const h = nativeHarness({ providers: [emailOtp()] });
  const statuses = await sendAll(h, "/auth/callback/email-otp", emails(IP_SENDS + 10));
  assertEquals(h.mail.length, IP_SENDS);
  assertEquals(statuses.filter((s) => s === 429).length, 10);
  // Another client address still gets through.
  await sendAll(h, "/auth/callback/email-otp", [{ email: "late@x.test" }], "198.51.100.7");
  assertEquals(h.mail.length, IP_SENDS + 1);
});

Deno.test("email-code sends: one identifier gets 3 mails, whichever addresses ask", async () => {
  const h = nativeHarness({ providers: [emailOtp()] });
  const peers = Array.from({ length: 8 }, (_, i) => `203.0.113.${20 + i}`);
  const statuses: number[] = [];
  for (const peer of peers) {
    statuses.push(...await sendAll(h, "/auth/callback/email-otp", [{ email: "a@x.test" }], peer));
  }
  assertEquals(h.mail.length, 3);
  assertEquals(statuses, [200, 200, 200, 429, 429, 429, 429, 429]);
});

Deno.test("password-reset mail: per-address and per-client budgets before the mailer", async () => {
  const h = nativeHarness({ providers: [emailOtp()] });
  for (const { email } of emails(IP_SENDS + 5)) await h.adapter.createUser({ email });
  await sendAll(h, "/auth/reset", emails(IP_SENDS + 5));
  assertEquals(h.mail.length, IP_SENDS);
  const one = nativeHarness({ providers: [emailOtp()] });
  await one.adapter.createUser({ email: "u0@x.test" });
  const statuses = await sendAll(one, "/auth/reset", Array(5).fill({ email: "u0@x.test" }));
  assertEquals([one.mail.length, statuses.at(-1)], [3, 429]);
});

Deno.test("phone sign-in codes: per-number and per-client budgets before the SMS gateway", async () => {
  const h = nativeHarness({ providers: [phoneOtp()] });
  const statuses = await sendAll(h, "/auth/callback/phone", phones(IP_SENDS + 10));
  assertEquals(h.sms.length, IP_SENDS);
  assertEquals(statuses.filter((s) => s === 429).length, 10);
  const one = nativeHarness({ providers: [phoneOtp()] });
  const peers = Array.from({ length: 6 }, (_, i) => `203.0.113.${40 + i}`);
  for (const peer of peers) await sendAll(one, "/auth/callback/phone", phones(1), peer);
  assertEquals(one.sms.length, 3);
});
