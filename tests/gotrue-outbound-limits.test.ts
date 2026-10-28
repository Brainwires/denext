// `/auth/v1`: every outbound call an unauthenticated (or ordinary user's) request can trigger —
// the captcha verifier, the mailer, the SMS gateway — sits behind a cheap per-client-address
// budget AND (for sends) a per-identifier one, both spent before the provider is called. A
// counting fake verifier / sender proves a burst reaches the provider at most budget-many
// times, and that the answer past the budget is GoTrue's 429.

import { assertEquals } from "@std/assert";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import type { GoTrueOptions } from "../packages/auth/src/gotrue/options.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { ORIGIN, type SupabaseAuthApp, supabaseAuthApp } from "./_supabase-auth-app.ts";

/** The per-address send budget (3) times the IP-wide factor (10). */
const IP_SENDS = 30;
/** The default captcha budget per client address per minute. */
const CAPTCHA_BUDGET = 30;

interface Call {
  method?: string;
  body?: unknown;
  token?: string;
  query?: Record<string, string>;
  /** The API key (default: the publishable key). */
  key?: string;
  /** The socket peer (default 203.0.113.9). */
  peer?: string;
}

/** Call `/auth/v1<path>` from `peer`. */
async function api(app: SupabaseAuthApp, path: string, call: Call = {}) {
  const url = new URL(`${ORIGIN}/auth/v1${path}`);
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { apikey: call.key ?? app.publishableKey };
  const bearer = call.token ?? call.key;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (call.body !== undefined) headers["content-type"] = "application/json";
  const request = new Request(url, {
    method: call.method ?? (call.body === undefined ? "GET" : "POST"),
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  setRemoteAddr(request, { transport: "tcp", hostname: call.peer ?? "203.0.113.9", port: 443 });
  const res = await app.fetch(request);
  const text = await res.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  return { status: res.status, json };
}

/** Run `fn` against an app with the default rate limits on. */
async function withApp(
  auth: GoTrueOptions,
  fn: (app: SupabaseAuthApp) => Promise<void>,
): Promise<void> {
  const app = await supabaseAuthApp({
    adapter: inMemoryAuthAdapter(),
    auth,
    authConfig: { rateLimit: {} },
    withClient: false,
  });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

/** A counting fake verifier: `good` is solved, anything else is not. */
function fakeVerifier() {
  const calls: string[] = [];
  const fetch = (_url: string | URL | Request, init?: RequestInit) => {
    const token = new URLSearchParams(String(init?.body)).get("response")!;
    calls.push(token);
    return Promise.resolve(Response.json({ success: token === "good" }));
  };
  return { calls, captcha: { provider: "hcaptcha" as const, secret: "s", fetch } };
}

/** The `error_code`s of `n` calls (`200` for a success). */
async function codes(
  n: number,
  each: (i: number) => Promise<{ status: number; json: Record<string, unknown> }>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const res = await each(i);
    out.push(res.status === 200 ? 200 : res.json.error_code);
  }
  return out;
}

const count = (values: unknown[], value: unknown) => values.filter((v) => v === value).length;

/** A confirmed user signed in with a password; their access token. */
async function signedIn(app: SupabaseAuthApp, email = "u@example.com"): Promise<string> {
  const created = await api(app, "/admin/users", {
    key: app.secretKey,
    body: { email, password: "a password!", email_confirm: true },
  });
  assertEquals(created.status, 200, JSON.stringify(created.json));
  const session = await api(app, "/token", {
    query: { grant_type: "password" },
    body: { email, password: "a password!" },
  });
  assertEquals(session.status, 200, JSON.stringify(session.json));
  return session.json.access_token as string;
}

// ---- captcha -----------------------------------------------------------------------------

Deno.test("captcha: a burst of solved tokens reaches the verifier at most budget-many times per address", async () => {
  const verifier = fakeVerifier();
  await withApp({ anonymousUsers: true, captcha: verifier.captcha }, async (app) => {
    const body = { gotrue_meta_security: { captcha_token: "good" } };
    const seen = await codes(CAPTCHA_BUDGET + 10, () => api(app, "/signup", { body }));
    assertEquals(verifier.calls.length, CAPTCHA_BUDGET);
    assertEquals([count(seen, 200), count(seen, "over_request_rate_limit")], [CAPTCHA_BUDGET, 10]);
    const other = await api(app, "/signup", { body, peer: "198.51.100.7" });
    assertEquals([other.status, verifier.calls.length], [200, CAPTCHA_BUDGET + 1]);
  });
});

Deno.test("captcha: unsolved tokens spend the budget; missing ones are refused without a call", async () => {
  const verifier = fakeVerifier();
  await withApp({ captcha: verifier.captcha }, async (app) => {
    const missing = await codes(40, () => api(app, "/otp", { body: { email: "a@example.com" } }));
    assertEquals([count(missing, "captcha_failed"), verifier.calls.length], [40, 0]);
    const bad = await codes(40, (i) =>
      api(app, "/token", {
        query: { grant_type: "password" },
        body: { email: `x${i}@example.com`, password: "p", captcha_token: "bad" },
      }));
    assertEquals(verifier.calls.length, CAPTCHA_BUDGET);
    assertEquals([count(bad, "captcha_failed"), count(bad, "over_request_rate_limit")], [30, 10]);
  });
});

// ---- email and SMS sends -----------------------------------------------------------------

Deno.test("/otp email: one client address can't send more than the IP-wide budget across addresses", async () => {
  await withApp({}, async (app) => {
    const seen = await codes(
      IP_SENDS + 5,
      (i) => api(app, "/otp", { body: { email: `u${i}@example.com` } }),
    );
    assertEquals(app.emails.length, IP_SENDS);
    assertEquals(count(seen, "over_email_send_rate_limit"), 5);
  });
});

Deno.test("/otp: one address gets 3 messages, whichever client addresses ask (email and SMS)", async () => {
  await withApp({}, async (app) => {
    const email = await codes(
      6,
      (i) => api(app, "/otp", { body: { email: "a@example.com" }, peer: `203.0.113.${20 + i}` }),
    );
    assertEquals([app.emails.length, email.at(-1)], [3, "over_email_send_rate_limit"]);
    const sms = await codes(
      6,
      (i) => api(app, "/otp", { body: { phone: "+15555550111" }, peer: `203.0.113.${40 + i}` }),
    );
    assertEquals([app.sms.length, sms.at(-1)], [3, "over_sms_send_rate_limit"]);
  });
});

Deno.test("/otp phone: one client address can't text more than the IP-wide budget across numbers", async () => {
  await withApp({}, async (app) => {
    const seen = await codes(
      IP_SENDS + 5,
      (i) => api(app, "/otp", { body: { phone: `+1555011${String(i).padStart(4, "0")}` } }),
    );
    assertEquals(app.sms.length, IP_SENDS);
    assertEquals(count(seen, "over_sms_send_rate_limit"), 5);
  });
});

Deno.test("/signup, /resend and /recover share the per-address and per-client send budgets", async () => {
  await withApp({}, async (app) => {
    const signup = await codes(
      IP_SENDS + 5,
      (i) => api(app, "/signup", { body: { email: `s${i}@example.com`, password: "a password!" } }),
    );
    assertEquals([app.emails.length, count(signup, "over_email_send_rate_limit")], [IP_SENDS, 5]);
    const resend = await codes(4, (i) =>
      api(app, "/resend", {
        body: { type: "signup", email: "s0@example.com" },
        peer: `198.51.100.${10 + i}`,
      }));
    // The sign-up spent one unit of s0's three.
    assertEquals(resend, [200, 200, "over_email_send_rate_limit", "over_email_send_rate_limit"]);
    const sms = await codes(
      4,
      (i) =>
        api(app, "/resend", { body: { type: "sms", phone: "+15555550112" }, peer: `192.0.2.${i}` }),
    );
    assertEquals(sms.slice(-1), ["over_sms_send_rate_limit"]);
    for (let i = 0; i < 5; i++) {
      await app.config.adapter!.createUser({ email: `r${i}@example.com` });
    }
    const before = app.emails.length;
    const recover = await codes(
      5,
      (i) => api(app, "/recover", { body: { email: "r0@example.com" }, peer: `192.0.2.${50 + i}` }),
    );
    assertEquals([app.emails.length - before, recover.at(-1)], [3, "over_email_send_rate_limit"]);
  });
});

Deno.test("signed-in sends: reauthenticate, email change and phone change are per-identifier bounded", async () => {
  await withApp({}, async (app) => {
    const token = await signedIn(app);
    const reauth = await codes(5, () => api(app, "/reauthenticate", { token }));
    assertEquals(reauth.at(-1), "over_request_rate_limit");
    assertEquals(app.emails.length, 3);
    const change = await codes(
      5,
      () => api(app, "/user", { method: "PUT", token, body: { email: "new@example.com" } }),
    );
    assertEquals([app.emails.length, change.at(-1)], [6, "over_email_send_rate_limit"]);
    const phone = await codes(
      5,
      () => api(app, "/user", { method: "PUT", token, body: { phone: "+15555550113" } }),
    );
    assertEquals([app.sms.length, phone.at(-1)], [3, "over_sms_send_rate_limit"]);
  });
});

Deno.test("factor challenge: the SMS budget is per user — re-enrolling the factor doesn't refill it", async () => {
  await withApp({ mfa: { phone: true } }, async (app) => {
    const token = await signedIn(app);
    const enroll = () =>
      api(app, "/factors", { token, body: { factor_type: "phone", phone: "+15555550114" } });
    const first = (await enroll()).json.id as string;
    const challenge = (id: string) => api(app, `/factors/${id}/challenge`, { token, body: {} });
    const seen = await codes(4, () => challenge(first));
    assertEquals([app.sms.length, seen.at(-1)], [3, "over_sms_send_rate_limit"]);
    assertEquals((await api(app, `/factors/${first}`, { token, method: "DELETE" })).status, 200);
    const second = (await enroll()).json.id as string;
    assertEquals((await challenge(second)).json.error_code, "over_sms_send_rate_limit");
    assertEquals(app.sms.length, 3);
  });
});
