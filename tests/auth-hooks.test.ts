// Supabase's auth hooks on denext's own endpoints: `hooks.sendEmail` delivers every native auth
// email (Supabase's Send Email Hook payload, one action type per flow) instead of
// `sendVerificationRequest`, and `hooks.sendSms` carries the phone MFA challenge.

import { assert, assertEquals } from "@std/assert";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { requestEmailVerification } from "../src/server/auth/email.ts";
import { resolveAuthOptions } from "../src/server/auth/options.ts";
import { credentials, emailOtp, magicLink } from "../src/server/auth/providers.ts";
import { assertEmailProviderConfig } from "../src/server/auth/providers-email.ts";
import type {
  GoTrueSendEmailPayload,
  GoTrueSmsMessage,
} from "../src/server/auth/gotrue/options.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { type NativeHarness, nativeHarness, ORIGIN, post } from "./helpers/auth-native-harness.ts";

function setup(extra: Partial<AuthConfig> = {}) {
  const hooked: GoTrueSendEmailPayload[] = [];
  const h: NativeHarness = nativeHarness({
    providers: [magicLink(), emailOtp(), credentials()],
    hooks: { sendEmail: (payload) => void hooked.push(payload) },
    ...extra,
  });
  return { h, hooked };
}

Deno.test("hooks.sendEmail: each native flow's mail arrives as Supabase's payload; sendVerificationRequest is not called", async () => {
  const { h, hooked } = setup();
  const member = await h.adapter.createUser({ email: "member@x.test" });
  await h.adapter.setCredential!(
    member.id,
    await resolveAuthOptions(h.config).hasher.hash("pw-123456"),
  );

  await post(h, "/auth/callback/email", { email: "member@x.test" });
  await post(h, "/auth/callback/email-otp", { email: "new@x.test" });
  await post(h, "/auth/reset", { email: "member@x.test" });
  const ctx = createRequestContext(new Request(`${ORIGIN}/`));
  await runWithContext(ctx, () => requestEmailVerification(h.config, "member@x.test"));
  await runDeferred(ctx);

  assertEquals(h.mail, [], "the hook replaces sendVerificationRequest");
  assertEquals(
    hooked.map((p) => p.email_data.email_action_type),
    ["magiclink", "email", "recovery", "signup"],
  );
  for (const payload of hooked) {
    const data = payload.email_data;
    assertEquals([data.token_hash, data.redirect_to, data.site_url], ["", "", ORIGIN]);
    assert(data.token.length > 0);
  }
  const [magic, code, reset, verify] = hooked;
  const link = new URL(magic.email_data.action_link);
  assertEquals(
    link.searchParams.get("token"),
    magic.email_data.token,
    "the link carries the token",
  );
  assertEquals([magic.user.id, magic.user.email], [member.id, "member@x.test"], "GoTrue user JSON");
  assertEquals(code.user, { email: "new@x.test" }, "no account yet");
  assertEquals(code.email_data.token.length, 6);
  assertEquals(new URL(code.email_data.action_link).searchParams.get("email"), "new@x.test");
  assertEquals(new URL(reset.email_data.action_link).pathname, "/auth/reset");
  assertEquals(new URL(verify.email_data.action_link).pathname, "/auth/verify");
});

Deno.test("hooks.sendEmail alone satisfies the email providers' config check", () => {
  assertEmailProviderConfig({
    secret: "s".repeat(40),
    providers: [emailOtp()],
    adapter: setup().h.adapter,
    hooks: { sendEmail: () => {} },
  });
});

Deno.test("hooks.sendSms carries the phone MFA challenge", async () => {
  const texts: GoTrueSmsMessage[] = [];
  const { h } = setup({
    sendSms: () => {
      throw new Error("the hook wins");
    },
    hooks: { sendSms: (message) => void texts.push(message) },
  });
  const user = await h.adapter.createUser({ email: "mfa@x.test", emailVerified: 1 });
  await h.adapter.setCredential!(
    user.id,
    await resolveAuthOptions(h.config).hasher.hash("pw-123456"),
  );
  const now = Math.floor(Date.now() / 1000);
  await h.adapter.createMfaFactor!({
    id: "factor-1",
    userId: user.id,
    type: "phone",
    status: "verified",
    phone: "+15550100003",
    createdAt: now,
    updatedAt: now,
  });
  const pending = await post(h, "/auth/callback/credentials", {
    email: "mfa@x.test",
    password: "pw-123456",
  });
  assertEquals(await pending.res.json(), { ok: true, mfa: "required" });
  const opened = await post(h, "/auth/mfa/challenge", { factorId: "factor-1" }, {
    cookie: pending.cookie,
  });
  assertEquals(opened.res.status, 200);
  assertEquals(texts.map((t) => [t.phone, t.type]), [["+15550100003", "mfa"]]);
});
