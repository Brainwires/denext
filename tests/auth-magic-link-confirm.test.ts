// `magicLink({ confirm: true })`: the link's GET renders a confirmation page and spends nothing
// (a link scanner's pre-fetch is harmless, however often it runs), the page's form POSTs the
// token back to the same URL, which signs in — and the refusals: a cross-origin POST, a page
// asked for without a token, attacker-controlled query values (escaped), framing (refused by
// header), and the default (no `confirm`) still signing in on the GET.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { emailOtp, magicLink } from "../src/server/auth/providers.ts";
import type { AuthConfig, VerificationRequestParams } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SESSION = "__Host-denext_auth";

/** An app on `magicLink(options)` with a recording mailer. */
function setup(options: Parameters<typeof magicLink>[0] = { confirm: true }) {
  const sent: VerificationRequestParams[] = [];
  const failures: string[] = [];
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    providers: [magicLink(options), emailOtp()],
    adapter: inMemoryAuthAdapter(),
    pages: { signIn: "/login", afterSignIn: "/home", error: "/oops" },
    sendVerificationRequest: (params) => void sent.push(params),
    events: { signInFailed: ({ reason }) => void failures.push(reason) },
  };
  return { config, sent, failures };
}

/** Run one request through the auth dispatcher, then flush the deferred mail. */
async function run(
  config: AuthConfig,
  request: Request,
): Promise<{ res: Response; ctx: RequestContext }> {
  setRemoteAddr(request, { transport: "tcp", hostname: "203.0.113.9", port: 443 });
  const ctx = createRequestContext(request);
  const res = await runWithContext(ctx, () => handleAuthRequest(request, config));
  await runDeferred(ctx);
  assert(res, "claimed");
  return { res, ctx };
}

/** Mail a link to `email`; returns its URL. */
async function mailLink(
  h: ReturnType<typeof setup>,
  email = "ada@example.com",
  callbackUrl?: string,
): Promise<URL> {
  const body = JSON.stringify({ email, ...(callbackUrl ? { callbackUrl } : {}) });
  await run(
    h.config,
    new Request(`${ORIGIN}/auth/callback/email`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", origin: ORIGIN },
      body,
    }),
  );
  return new URL(h.sent.at(-1)!.url);
}

/** The page's hidden form fields. */
function formFields(html: string): Record<string, string> {
  const unescape = (v: string) =>
    v.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  return Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
      .map(([, name, value]) => [name, unescape(value)]),
  );
}

/** Submit the page's form the way a browser does: a same-origin urlencoded POST. */
function submit(action: string, fields: Record<string, string>, origin = ORIGIN): Request {
  return new Request(new URL(action, ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams(fields),
  });
}

/** The session cookie a response set, if any. */
function sessionCookie(ctx: RequestContext): string | undefined {
  return ctx.outgoingHeaders.getSetCookie().find((c) => c.startsWith(`${SESSION}=`))?.split(";")[0];
}

Deno.test("confirm: the GET renders the page and spends nothing — however often a scanner fetches it", async () => {
  const h = setup();
  const link = await mailLink(h);
  for (let i = 0; i < 3; i++) {
    const { res, ctx } = await run(h.config, new Request(link));
    assertEquals(res.status, 200);
    assertEquals(sessionCookie(ctx), undefined, "no session from a GET");
    const html = await res.text();
    assertStringIncludes(html, "<strong>ada@example.com</strong>");
    assertStringIncludes(html, '<form method="post" action="/auth/callback/email">');
  }
  // The token survived three GETs: the form's POST still signs in.
  const page = await (await run(h.config, new Request(link))).res.text();
  const { res, ctx } = await run(h.config, submit("/auth/callback/email", formFields(page)));
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/home");
  assert(sessionCookie(ctx), "signed in by the POST");
  assertEquals(h.failures, []);
});

Deno.test("confirm: the POST spends the token — a second submit fails", async () => {
  const h = setup();
  const link = await mailLink(h, "ada@example.com", "/dashboard");
  const fields = formFields(await (await run(h.config, new Request(link))).res.text());
  assertEquals(fields.callbackUrl, "/dashboard");
  const first = await run(h.config, submit("/auth/callback/email", fields));
  assertEquals(first.res.headers.get("location"), "/dashboard");
  const again = await run(h.config, submit("/auth/callback/email", fields));
  assertEquals(
    new URL(again.res.headers.get("location")!, ORIGIN).searchParams.get("error"),
    "Verification",
  );
  assertEquals(sessionCookie(again.ctx), undefined);
  assertEquals(h.failures, ["invalid_credentials"]);
});

Deno.test("confirm: a cross-origin POST of the token is refused and leaves it unspent", async () => {
  const h = setup();
  const link = await mailLink(h);
  const fields = formFields(await (await run(h.config, new Request(link))).res.text());
  const evil = await run(h.config, submit("/auth/callback/email", fields, "https://evil.test"));
  assertEquals(evil.res.status, 403);
  assertEquals(sessionCookie(evil.ctx), undefined);
  const ok = await run(h.config, submit("/auth/callback/email", fields));
  assert(sessionCookie(ok.ctx), "the token is still good for the real page");
});

Deno.test("confirm: the page can't be framed, cached, scripted, or leak its URL cross-origin", async () => {
  const h = setup();
  const { res } = await run(h.config, new Request(await mailLink(h)));
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("x-frame-options"), "DENY");
  // `same-origin`, not `no-referrer`: the latter would send `Origin: null` on the form POST.
  assertEquals(res.headers.get("referrer-policy"), "same-origin");
  const csp = res.headers.get("content-security-policy")!;
  assertStringIncludes(csp, "default-src 'none'");
  assertStringIncludes(csp, "frame-ancestors 'none'");
  assertStringIncludes(csp, "form-action 'self'");
  assertMatch(csp, /style-src 'sha256-[A-Za-z0-9+/]+=*'/);
  // The hash really is the inline style's.
  const html = await res.text();
  const style = /<style>(.*?)<\/style>/.exec(html)![1];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  assertStringIncludes(csp, `'sha256-${b64}'`);
  assert(!/<script/i.test(html), "no script");
});

Deno.test("confirm: attacker-chosen query values are escaped, and a bad email or token renders nothing", async () => {
  const h = setup();
  const hostile = new URL(`${ORIGIN}/auth/callback/email`);
  hostile.searchParams.set("email", "ada@example.com");
  hostile.searchParams.set("token", `"><script>alert(1)</script>`);
  hostile.searchParams.set("callbackUrl", `"/><img src=x onerror=alert(1)>`);
  const html = await (await run(h.config, new Request(hostile))).res.text();
  assert(!html.includes("<script>alert"), "token escaped");
  assert(!html.includes("<img"), "callbackUrl escaped");
  assertEquals(formFields(html).token, `"><script>alert(1)</script>`, "round-trips unescaped");

  for (const query of ["?email=ada%40example.com", "?token=abc", "?token=abc&email=not-an-email"]) {
    const { res } = await run(h.config, new Request(`${ORIGIN}/auth/callback/email${query}`));
    assertEquals(res.status, 303);
    assertEquals(
      new URL(res.headers.get("location")!, ORIGIN).searchParams.get("error"),
      "Verification",
    );
  }
  const list = new URL(`${ORIGIN}/auth/callback/email`);
  list.searchParams.set("email", "a@x.test,b@y.test");
  list.searchParams.set("token", "abc");
  assertEquals((await run(h.config, new Request(list))).res.status, 303, "one address only");
});

Deno.test("confirm: off by default — the GET still signs in, and the OTP provider has no page", async () => {
  const h = setup({});
  assertEquals(h.config.providers[0].type === "email" && h.config.providers[0].confirm, undefined);
  const { res, ctx } = await run(h.config, new Request(await mailLink(h)));
  assertEquals(res.status, 303);
  assert(sessionCookie(ctx));
  const otp = await run(
    h.config,
    new Request(`${ORIGIN}/auth/callback/email-otp?token=1&email=a@x.test`),
  );
  assertEquals(otp.res.status, 405);
});
