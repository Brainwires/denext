// The HTTP-API email providers (`sendgrid`, `postmark`, `mailgun`, `forwardemail`, `loops`): each
// reads its key from `AUTH_<ID>_KEY` and sends Auth.js's sign-in mail through its service's API.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { translateConfig } from "../packages/auth/next-auth/config.ts";
import ForwardEmail from "../packages/auth/next-auth/providers/forwardemail.ts";
import Loops from "../packages/auth/next-auth/providers/loops.ts";
import Mailgun from "../packages/auth/next-auth/providers/mailgun.ts";
import Postmark from "../packages/auth/next-auth/providers/postmark.ts";
import SendGrid from "../packages/auth/next-auth/providers/sendgrid.ts";
import type { Provider } from "../packages/auth/next-auth/types.ts";

const SECRET = "next-auth-email-providers-secret-32-chars";

interface Sent {
  url: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

/** Send one sign-in mail through `provider`, capturing the API request. */
async function send(
  provider: Provider,
  env: Record<string, string>,
  status = 200,
): Promise<Sent> {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body });
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  try {
    const active = translateConfig({ secret: SECRET, providers: [provider] }, (n) => env[n]);
    await active.denext.sendVerificationRequest!({
      identifier: "ada@example.com",
      url: "https://app.test/api/auth/callback/x?token=t",
      token: "t",
      purpose: "magic",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(sent.length, 1);
  return sent[0];
}

const json = (body: Sent["body"]) => JSON.parse(String(body)) as Record<string, unknown>;

Deno.test("next-auth email: SendGrid's Mail Send API with AUTH_SENDGRID_KEY", async () => {
  const sent = await send(SendGrid({ from: "auth@app.test" }), { AUTH_SENDGRID_KEY: "sg" });
  assertEquals(sent.url, "https://api.sendgrid.com/v3/mail/send");
  assertEquals(sent.headers.get("authorization"), "Bearer sg");
  const body = json(sent.body);
  assertEquals(body.personalizations, [{ to: [{ email: "ada@example.com" }] }]);
  assertEquals(body.from, { email: "auth@app.test" });
  assertEquals(body.subject, "Sign in to app.test");
});

Deno.test("next-auth email: Postmark's server token header", async () => {
  const sent = await send(Postmark({ apiKey: "pm" }), {});
  assertEquals(sent.url, "https://api.postmarkapp.com/email");
  assertEquals(sent.headers.get("x-postmark-server-token"), "pm");
  assertEquals(json(sent.body).To, "ada@example.com");
  assertEquals(json(sent.body).From, "Auth.js <no-reply@authjs.dev>");
});

Deno.test("next-auth email: Forward Email's Basic key", async () => {
  const sent = await send(ForwardEmail, { AUTH_FORWARDEMAIL_KEY: "fe" });
  assertEquals(sent.url, "https://api.forwardemail.net/v1/emails");
  assertEquals(sent.headers.get("authorization"), `Basic ${btoa("fe:")}`);
  assert(String(json(sent.body).text).includes("https://app.test/api/auth/callback/x?token=t"));
});

Deno.test("next-auth email: Loops' transactional email gets the link as `url`", async () => {
  const sent = await send(Loops({ transactionalId: "tx1" }), { AUTH_LOOPS_KEY: "lp" });
  assertEquals(sent.url, "https://app.loops.so/api/v1/transactional");
  assertEquals(json(sent.body), {
    transactionalId: "tx1",
    email: "ada@example.com",
    dataVariables: { url: "https://app.test/api/auth/callback/x?token=t" },
  });
  await assertRejects(() => send(Loops(), { AUTH_LOOPS_KEY: "lp" }), TypeError, "transactionalId");
});

Deno.test("next-auth email: Mailgun posts a form to the region's host for the from domain", async () => {
  const sent = await send(Mailgun({ from: "auth@mg.app.test", region: "EU" }), {
    AUTH_MAILGUN_KEY: "mg",
  });
  assertEquals(sent.url, "https://api.eu.mailgun.net/v3/mg.app.test/messages");
  assertEquals(sent.headers.get("authorization"), `Basic ${btoa("api:mg")}`);
  const form = sent.body as FormData;
  assertEquals(form.get("from"), "Mailgun <auth@mg.app.test>");
  assertEquals(form.get("to"), "ada@example.com");
  const us = await send(Mailgun({ from: "auth@mg.app.test" }), { AUTH_MAILGUN_KEY: "mg" });
  assertEquals(new URL(us.url).host, "api.mailgun.net");
});

Deno.test("next-auth email: Mailgun's message fields, and a from address with no domain", async () => {
  const sent = await send(Mailgun({ from: "auth@mg.app.test" }), {
    AUTH_MAILGUN_KEY: "mg",
  });
  const form = sent.body as FormData;
  assertEquals(form.get("subject"), "Sign in to app.test");
  assert(String(form.get("html")).includes("https://app.test/api/auth/callback/x?token=t"));
  assert(String(form.get("text")).includes("https://app.test/api/auth/callback/x?token=t"));
  await assertRejects(
    () => send(Mailgun({ from: "no-domain" }), { AUTH_MAILGUN_KEY: "mg" }),
    Error,
    "malformed Mailgun domain",
  );
});

Deno.test("next-auth email: no key, or a refusing API, fails the send", async () => {
  await assertRejects(() => send(SendGrid(), {}), Error, "AUTH_SENDGRID_KEY");
  await assertRejects(() => send(Postmark(), { AUTH_POSTMARK_KEY: "k" }, 401), Error, "401");
});
