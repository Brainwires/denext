// The `next-auth` (Auth.js v5) shim: the config translation, the sealed token, the handlers'
// Auth.js endpoints, the server-side signIn / signOut, middleware, and the Auth.js adapter
// bridge. Security: every state-changing POST needs BOTH the same-origin check and the CSRF
// token, and a `redirect` callback can't send the browser off-origin.

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import NextAuth, { CredentialsSignin, type NextAuthConfig } from "../src/compat/next-auth/index.ts";
import Credentials from "../src/compat/next-auth/providers/credentials.ts";
import GitHub from "../src/compat/next-auth/providers/github.ts";
import MicrosoftEntraID from "../src/compat/next-auth/providers/microsoft-entra-id.ts";
import Resend from "../src/compat/next-auth/providers/resend.ts";
import Apple from "../src/compat/next-auth/providers/apple.ts";
import Discord from "../src/compat/next-auth/providers/discord.ts";
import Email from "../src/compat/next-auth/providers/email.ts";
import Google from "../src/compat/next-auth/providers/google.ts";
import Nodemailer, { smtpSettings } from "../src/compat/next-auth/providers/nodemailer.ts";
import { translateConfig } from "../src/compat/next-auth/config.ts";
import { decode, encode, getToken } from "../src/compat/next-auth/jwt.ts";
import { type AuthJsAdapter, fromAuthJsAdapter } from "../src/compat/next-auth/adapter.ts";
import type { OAuthProvider } from "../src/server/auth/types.ts";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { isRedirect } from "../src/runtime/error-boundary.ts";

const ORIGIN = "https://app.test";
const SECRET = "next-auth-shim-test-secret-at-least-32-chars";

/** A cookie jar over `Set-Cookie` headers. */
class Jar {
  cookies = new Map<string, string>();
  take(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

interface CallInit {
  method?: string;
  form?: Record<string, string>;
  json?: unknown;
  origin?: string | null;
  headers?: Record<string, string>;
}

/** Run `fn` inside a request context for `request`, merging its cookies into the answer. */
async function inRequest<T>(
  request: Request,
  jar: Jar,
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; cookies: Headers }> {
  const ctx = createRequestContext(request);
  let value: T | undefined;
  let error: unknown;
  try {
    value = await runWithContext(ctx, fn);
  } catch (err) {
    error = err;
  }
  await runDeferred(ctx);
  jar.take(ctx.outgoingHeaders);
  return { value, error, cookies: ctx.outgoingHeaders };
}

/** A request body and its content type. */
function bodyOf(init: CallInit): { type?: string; body?: BodyInit } {
  if (init.form) {
    return { type: "application/x-www-form-urlencoded", body: new URLSearchParams(init.form) };
  }
  if (init.json === undefined) return {};
  return { type: "application/json", body: JSON.stringify(init.json) };
}

/** Build a request to the app. */
function request(jar: Jar, path: string, init: CallInit = {}): Request {
  const headers = new Headers({ host: "app.test", ...(init.headers ?? {}) });
  if (jar.cookies.size) headers.set("cookie", jar.header());
  const { type, body } = bodyOf(init);
  if (type) headers.set("content-type", type);
  const method = init.method ?? (body ? "POST" : "GET");
  if (method !== "GET" && init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

/** A NextAuth instance plus a browser (cookie jar) that talks to its handlers. */
function app(config: Partial<NextAuthConfig> = {}) {
  const result = NextAuth({
    secret: SECRET,
    providers: [
      Credentials({
        credentials: {
          email: { label: "Email" },
          password: { label: "Password", type: "password" },
        },
        authorize: (c) =>
          c.email === "ada@example.com" && c.password === "pw"
            ? { id: "u1", name: "Ada", email: "ada@example.com", role: "admin" }
            : null,
      }),
    ],
    ...config,
  });
  const jar = new Jar();
  const call = async (path: string, init: CallInit = {}): Promise<Response> => {
    const req = request(jar, path, init);
    const handler = req.method === "GET" ? result.handlers.GET : result.handlers.POST;
    const { value, error } = await inRequest(req, jar, () => handler(req));
    if (error) throw error;
    jar.take(value!.headers);
    return value!;
  };
  const csrf = async () =>
    ((await (await call("/api/auth/csrf")).json()) as { csrfToken: string }).csrfToken;
  const run = <T>(fn: () => Promise<T>, init: CallInit = {}) =>
    inRequest(request(jar, "/action", { method: "POST", ...init }), jar, fn);
  return { result, jar, call, csrf, run };
}

async function signInWithPassword(
  a: ReturnType<typeof app>,
  password = "pw",
  callbackUrl = "/home",
): Promise<Response> {
  return await a.call("/api/auth/callback/credentials", {
    form: { csrfToken: await a.csrf(), email: "ada@example.com", password, callbackUrl },
  });
}

Deno.test("next-auth config: Auth.js env defaults, AUTH_URL, strategy", () => {
  const env: Record<string, string> = {
    AUTH_SECRET: SECRET,
    AUTH_URL: "https://app.test/custom/auth/",
    AUTH_GITHUB_ID: "gh-id",
    AUTH_GITHUB_SECRET: "gh-secret",
    AUTH_MICROSOFT_ENTRA_ID_ID: "ms-id",
    AUTH_MICROSOFT_ENTRA_ID_SECRET: "ms-secret",
    AUTH_MICROSOFT_ENTRA_ID_ISSUER:
      "https://login.microsoftonline.com/5f1c6e7a-0000-4000-8000-000000000001/v2.0",
  };
  const active = translateConfig(
    { providers: [GitHub, MicrosoftEntraID({ authorization: { params: { prompt: "login" } } })] },
    (name) => env[name],
  );
  assertEquals(active.basePath, "/custom/auth");
  assertEquals(active.denext.canonicalOrigin, "https://app.test");
  assertEquals(active.secret, SECRET);
  assertEquals(active.strategy, "jwt");
  assertEquals(active.denext.session?.strategy, "cookie");
  assertEquals(active.denext.session?.updateAge, 86400);
  const [gh, ms] = active.denext.providers as OAuthProvider[];
  assertEquals([gh.id, gh.clientId, gh.clientSecret], ["github", "gh-id", "gh-secret"]);
  assertEquals(ms.id, "microsoft-entra-id");
  assertEquals(ms.clientId, "ms-id");
  assertEquals(ms.authorizationParams?.prompt, "login");
  assert(ms.authorizationUrl.includes("5f1c6e7a-0000-4000-8000-000000000001"));
  assertEquals(active.denext.pages?.signIn, "/custom/auth/signin");
});

Deno.test("next-auth providers: every preset, the email providers and custom objects", () => {
  const env = (name: string) =>
    name.endsWith("_ID") ? "id" : name.endsWith("_SECRET") ? "secret" : undefined;
  const active = translateConfig({
    secret: SECRET,
    providers: [
      Google({ authorization: { params: { scope: "openid email", prompt: "consent" } } }),
      Apple,
      Discord({ id: "discord-eu", allowDangerousEmailAccountLinking: true }),
      Nodemailer({ server: "smtp://u:p@mail.test:587", from: "a@app.test" }),
      Email({ server: "smtps://mail.test", from: "a@app.test" }),
      {
        id: "acme",
        name: "Acme",
        type: "oidc",
        issuer: "https://login.acme.test",
        clientId: "c",
        clientSecret: "s",
      },
    ],
  }, env);
  const [google, apple, discord, nodemailer, email, acme] = active.denext
    .providers as OAuthProvider[];
  assertEquals(google.scopes, ["openid", "email"]);
  assertEquals(google.authorizationParams?.prompt, "consent");
  assertEquals(apple.responseMode, "form_post");
  assertEquals([discord.id, discord.allowDangerousEmailAccountLinking], ["discord-eu", true]);
  assertEquals([nodemailer.id, nodemailer.type], ["nodemailer", "email"]);
  assertEquals(email.id, "email");
  assertEquals([acme.id, acme.type, acme.issuer], ["acme", "oidc", "https://login.acme.test"]);
  assertEquals(active.providers.map((p) => p.type), [
    "oidc",
    "oidc",
    "oauth",
    "email",
    "email",
    "oidc",
  ]);
  assertEquals(smtpSettings("smtps://us%40r:p%3Ass@mail.test:465", "a@app.test"), {
    host: "mail.test",
    port: 465,
    secure: true,
    user: "us@r",
    pass: "p:ss",
    from: "a@app.test",
  });
});

Deno.test("next-auth providers: a profile() override decides the account id and email", async () => {
  const active = translateConfig({
    secret: SECRET,
    providers: [
      GitHub({
        clientId: "id",
        clientSecret: "secret",
        profile: async (profile) => {
          await Promise.resolve();
          return { id: `gh-${profile.id}`, name: "Override", email: String(profile.mail) };
        },
      }),
      Google({
        clientId: "id",
        clientSecret: "secret",
        profile: (profile) => ({ id: String(profile.sub), email: String(profile.email) }),
      }),
    ],
  }, () => undefined);
  const [gh, google] = active.denext.providers as OAuthProvider[];
  const user = await gh.profile({
    tokens: {},
    userinfo: { id: 7, mail: "chosen@example.com" },
    emails: [{ email: "verified@example.com", primary: true, verified: true }],
  });
  assertEquals(user.id, "gh-7");
  assertEquals(user.name, "Override");
  assertEquals(user.email, "chosen@example.com");
  assertEquals(user.emailVerified, undefined, "only the preset's own address keeps its verdict");
  const same = await google.profile({
    tokens: {},
    claims: { sub: "g1", email: "a@example.com", email_verified: true },
  });
  assertEquals([same.id, same.email, same.emailVerified], ["g1", "a@example.com", true]);
});

Deno.test("next-auth config: an adapter defaults the strategy to database", () => {
  const sessions = new Map<string, { sessionToken: string; userId: string; expires: Date }>();
  const adapter = memoryAdapter(sessions);
  const active = translateConfig({ secret: SECRET, adapter, providers: [] }, () => undefined);
  assertEquals(active.strategy, "database");
  assertEquals(active.denext.session?.strategy, "database");
  assert(active.denext.adapter?.sessions, "the adapter's sessions back the store");
});

Deno.test("next-auth config: Resend reads AUTH_RESEND_KEY and becomes the mail sender", async () => {
  const sent: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const env: Record<string, string> = { AUTH_RESEND_KEY: "re_key" };
    const active = translateConfig(
      { secret: SECRET, providers: [Resend({ from: "auth@app.test" })] },
      (name) => env[name],
    );
    assertEquals(active.denext.providers[0].id, "resend");
    await active.denext.sendVerificationRequest!({
      identifier: "ada@example.com",
      url: "https://app.test/api/auth/callback/resend?token=t",
      token: "t",
      purpose: "magic",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    assertEquals(sent.length, 1);
    assertEquals(sent[0].url, "https://api.resend.com/emails");
    assertEquals(sent[0].auth, "Bearer re_key");
    assertEquals(sent[0].body.to, "ada@example.com");
    assertEquals(sent[0].body.from, "auth@app.test");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("next-auth/jwt: encode/decode round-trip, tamper, wrong secret, rotation, expiry", async () => {
  const token = await encode({ token: { sub: "u1", role: "admin" }, secret: SECRET });
  assert(!token.includes("admin"), "the claims are encrypted, not just signed");
  const claims = await decode({ token, secret: SECRET });
  assertEquals(claims?.sub, "u1");
  assertEquals(claims?.role, "admin");
  const flipped = token.slice(0, -2) + (token.endsWith("A") ? "BA" : "AA");
  assertEquals(await decode({ token: flipped, secret: SECRET }), null);
  assertEquals(await decode({ token, secret: "another-secret-another-secret-12345" }), null);
  assertEquals(await decode({ token, secret: SECRET, salt: "other" }), null);
  const rotated = await decode({ token, secret: ["a-new-secret-a-new-secret-a-new-1234", SECRET] });
  assertEquals(rotated?.sub, "u1");
  const expired = await encode({ token: { sub: "u1" }, secret: SECRET, maxAge: -1 });
  assertEquals(await decode({ token: expired, secret: SECRET }), null);
});

Deno.test("next-auth: credentials sign-in, the Auth.js session shape, jwt + session callbacks", async () => {
  const a = app({
    callbacks: {
      jwt: ({ token, user, account, trigger }) => {
        if (user) token.role = (user as { role?: string }).role;
        if (account) token.provider = account.provider;
        if (trigger) token.trigger = trigger;
        return token;
      },
      session: ({ session, token }) => ({ ...session, role: token.role, provider: token.provider }),
    },
  });
  const res = await signInWithPassword(a);
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/home");
  assert(a.jar.cookies.has("__Host-denext_auth"), "https: denext's __Host- session cookie");
  const session = await (await a.call("/api/auth/session")).json();
  assertEquals(session.user, { id: "u1", name: "Ada", email: "ada@example.com" });
  assertEquals(session.role, "admin");
  assertEquals(session.provider, "credentials");
  assert(!Number.isNaN(Date.parse(session.expires)));
  const token = await a.run(() => getToken({}));
  assertEquals((token.value as { trigger?: string })?.trigger, "signIn");
  const raw = await a.run(() => getToken({ raw: true }));
  assert(String(raw.value).startsWith("dnx1."), "the sealed token");
  // The server-side read in a Server Component / route handler:
  const read = await a.run(() => a.result.auth());
  assertEquals((read.value as { role?: string })?.role, "admin");
});

Deno.test("next-auth: a wrong password lands on the sign-in page with CredentialsSignin", async () => {
  const a = app();
  const res = await signInWithPassword(a, "nope", "/home");
  assertEquals(res.status, 302);
  const location = new URL(res.headers.get("location")!, ORIGIN);
  assertEquals(location.pathname, "/api/auth/signin");
  assertEquals(location.searchParams.get("error"), "CredentialsSignin");
  assertEquals(location.searchParams.get("code"), "credentials");
  assertEquals(await (await a.call("/api/auth/session")).json(), null);
});

Deno.test("next-auth: X-Auth-Return-Redirect answers { url } instead of a redirect", async () => {
  const a = app();
  const res = await a.call("/api/auth/callback/credentials", {
    form: {
      csrfToken: await a.csrf(),
      email: "ada@example.com",
      password: "pw",
      callbackUrl: "/x",
    },
    headers: { "x-auth-return-redirect": "1" },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { url: `${ORIGIN}/x` });
});

Deno.test("next-auth security: CSRF — a POST without this browser's token is refused", async () => {
  const a = app();
  // No token at all.
  const none = await a.call("/api/auth/callback/credentials", {
    form: { email: "ada@example.com", password: "pw" },
  });
  assertEquals(none.status, 403);
  // Another browser's token (double-submit: it must match THIS browser's signed cookie).
  const other = app();
  const foreign = await other.csrf();
  await a.csrf();
  const swapped = await a.call("/api/auth/callback/credentials", {
    form: { csrfToken: foreign, email: "ada@example.com", password: "pw" },
  });
  assertEquals(swapped.status, 403);
  // The right token from a cross-origin page: denext's same-origin check still refuses it.
  const crossOrigin = await a.call("/api/auth/callback/credentials", {
    form: { csrfToken: await a.csrf(), email: "ada@example.com", password: "pw" },
    origin: "https://evil.test",
  });
  assertEquals(crossOrigin.status, 403);
  // And with no Origin (nor Referer) at all.
  const noOrigin = await a.call("/api/auth/callback/credentials", {
    form: { csrfToken: await a.csrf(), email: "ada@example.com", password: "pw" },
    origin: null,
  });
  assertEquals(noOrigin.status, 403);
  assertEquals(await (await a.call("/api/auth/session")).json(), null, "nobody signed in");
});

Deno.test("next-auth security: CSRF — sign-out, sign-in start and update need the token", async () => {
  const a = app();
  await signInWithPassword(a);
  assertEquals((await a.call("/api/auth/signout", { form: {} })).status, 403);
  assertEquals((await a.call("/api/auth/signin/credentials", { form: {} })).status, 403);
  assertEquals((await a.call("/api/auth/session", { json: { data: "{}" } })).status, 403);
  assertNotEquals(await (await a.call("/api/auth/session")).json(), null, "still signed in");
  const out = await a.call("/api/auth/signout", {
    form: { csrfToken: await a.csrf(), callbackUrl: "/bye" },
  });
  assertEquals(out.status, 302);
  assertEquals(out.headers.get("location"), "/bye");
  assertEquals(await (await a.call("/api/auth/session")).json(), null);
});

Deno.test("next-auth security: a callbackUrl never leaves the origin", async () => {
  for (const callbackUrl of ["https://evil.test/x", "//evil.test/x", "javascript:alert(1)"]) {
    const a = app();
    const res = await signInWithPassword(a, "pw", callbackUrl);
    assertEquals(res.headers.get("location"), "/", callbackUrl);
  }
  const same = app();
  const res = await signInWithPassword(same, "pw", `${ORIGIN}/deep?x=1`);
  assertEquals(res.headers.get("location"), "/deep?x=1");
});

Deno.test("next-auth security: the redirect callback's foreign answer is kept same-origin", async () => {
  const seen: { url: string; baseUrl: string }[] = [];
  const a = app({
    callbacks: {
      redirect: (params) => {
        seen.push(params);
        return "https://evil.test/phish";
      },
    },
  });
  const res = await signInWithPassword(a, "pw", "/home");
  assertEquals(res.headers.get("location"), "/");
  assertEquals(seen, [{ url: `${ORIGIN}/home`, baseUrl: ORIGIN }]);
  const own = app({ callbacks: { redirect: ({ baseUrl }) => `${baseUrl}/welcome` } });
  assertEquals((await signInWithPassword(own)).headers.get("location"), "/welcome");
  const throwing = app({
    callbacks: {
      redirect: () => {
        throw new Error("boom");
      },
    },
  });
  assertEquals((await signInWithPassword(throwing, "pw", "/home")).headers.get("location"), "/");
});

Deno.test("next-auth: a signIn callback that refuses (false or a URL) refuses", async () => {
  for (const verdict of [false, "/elsewhere"] as const) {
    const a = app({ callbacks: { signIn: () => verdict } });
    const res = await signInWithPassword(a);
    assert(res.headers.get("location")!.includes("error=CredentialsSignin"));
    assertEquals(await (await a.call("/api/auth/session")).json(), null);
  }
  const seen: Record<string, unknown>[] = [];
  const ok = app({
    callbacks: {
      signIn: (params) => {
        seen.push(params as unknown as Record<string, unknown>);
        return true;
      },
    },
  });
  await signInWithPassword(ok);
  assertEquals((seen[0].account as { provider: string }).provider, "credentials");
  assertEquals((seen[0].credentials as { email: string }).email, "ada@example.com");
  assertEquals((seen[0].user as { role: string }).role, "admin");
});

Deno.test("next-auth: update() runs jwt with trigger update and rewrites the token", async () => {
  const a = app({
    callbacks: {
      jwt: ({ token, trigger, session }) => {
        if (trigger === "update") token.nickname = (session as { nickname: string }).nickname;
        return token;
      },
      session: ({ session, token }) => ({ ...session, nickname: token.nickname ?? null }),
    },
  });
  await signInWithPassword(a);
  const updated = await a.call("/api/auth/session", {
    json: { csrfToken: await a.csrf(), data: JSON.stringify({ nickname: "countess" }) },
  });
  assertEquals((await updated.json()).nickname, "countess");
  assertEquals((await (await a.call("/api/auth/session")).json()).nickname, "countess");
});

Deno.test("next-auth: a jwt callback returning null signs the session out", async () => {
  let allow = true;
  const a = app({ callbacks: { jwt: ({ token }) => allow ? token : null } });
  await signInWithPassword(a);
  assertNotEquals(await (await a.call("/api/auth/session")).json(), null);
  allow = false;
  assertEquals(await (await a.call("/api/auth/session")).json(), null);
  assert(!a.jar.cookies.has("__Host-denext_auth"), "the cookie was cleared");
});

Deno.test("next-auth: providers, csrf and the built-in pages", async () => {
  const a = app();
  const providers = await (await a.call("/api/auth/providers")).json();
  assertEquals(providers.credentials.type, "credentials");
  assertEquals(providers.credentials.callbackUrl, `${ORIGIN}/api/auth/callback/credentials`);
  const token = await a.csrf();
  assertEquals(await a.csrf(), token, "the token is stable for the browser");
  const page = await a.call("/api/auth/signin?callbackUrl=%2Fhere&error=CredentialsSignin");
  const html = await page.text();
  assert(html.includes(`name="csrfToken" value="${token}"`));
  assert(html.includes(`name="callbackUrl" value="/here"`));
  assert(html.includes('type="password"'));
  assert(html.includes("Sign in failed"));
  assert(!html.includes("<script"), "no script: it renders under the strict CSP");
  const xss = await (await a.call(
    `/api/auth/signin?callbackUrl=${encodeURIComponent('"><script>x</script>')}`,
  )).text();
  assert(!xss.includes("<script>x"), "values are escaped");
  assertEquals((await a.call("/api/auth/error?error=Configuration")).status, 500);
  assertEquals((await a.call("/api/auth/verify-request")).status, 200);
});

Deno.test("next-auth: an OAuth callback error is renamed to the Auth.js code", async () => {
  const a = app({
    providers: [
      GitHub({ clientId: "id", clientSecret: "secret" }),
    ],
  });
  const res = await a.call("/api/auth/callback/github?code=x&state=forged");
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/api/auth/signin?error=OAuthCallbackError");
});

Deno.test("next-auth: an OAuth sign-in starts with state + PKCE through the POST", async () => {
  const a = app({ providers: [GitHub({ clientId: "id", clientSecret: "secret" })] });
  const res = await a.call("/api/auth/signin/github", {
    form: { csrfToken: await a.csrf(), callbackUrl: "/after" },
  });
  assertEquals(res.status, 302);
  const to = new URL(res.headers.get("location")!);
  assertEquals(to.host, "github.com");
  assertEquals(to.searchParams.get("code_challenge_method"), "S256");
  assert(to.searchParams.get("state"));
  assertEquals(to.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/github`);
  assert(a.jar.cookies.has("__Host-denext_auth_tx"), "the transaction cookie");
});

Deno.test("next-auth: server-side signIn / signOut from a Server Action", async () => {
  const a = app();
  const form = new FormData();
  form.set("email", "ada@example.com");
  form.set("password", "nope");
  const refused = await a.run(() => a.result.signIn("credentials", form));
  assert(refused.error instanceof CredentialsSignin);
  assertEquals((refused.error as CredentialsSignin).type, "CredentialsSignin");
  form.set("password", "pw");
  form.set("redirectTo", "/dash");
  const ok = await a.run(() => a.result.signIn("credentials", form));
  assert(isRedirect(ok.error), "redirects, like Next's redirect()");
  assertEquals((ok.error as { url: string }).url, "/dash");
  const me = await a.run(() => a.result.auth());
  assertEquals(me.value?.user?.email, "ada@example.com");
  const url = await a.run(() => a.result.signOut({ redirect: false, redirectTo: "/bye" }));
  assertEquals(url.value, "/bye");
  assertEquals((await a.run(() => a.result.auth())).value, null);
  await assertRejects(() => a.result.signIn("credentials", form), Error, "during a request");
});

Deno.test("next-auth: middleware — authorized decides, auth(handler) gets request.auth", async () => {
  const a = app({
    callbacks: {
      authorized: ({ auth, request }) =>
        request.nextUrl.pathname.startsWith("/admin") ? !!auth : true,
    },
  });
  const middleware = (path: string) => {
    const req = request(a.jar, path);
    return a.run(() => a.result.auth(req) as Promise<Response>);
  };
  const refused = (await middleware("/admin/x?y=1")).value!;
  assertEquals(refused.status, 307);
  assertEquals(
    refused.headers.get("location"),
    `${ORIGIN}/api/auth/signin?callbackUrl=%2Fadmin%2Fx%3Fy%3D1`,
  );
  assertEquals((await middleware("/public")).value!.headers.get("x-middleware-next"), "1");
  await signInWithPassword(a);
  assertEquals((await middleware("/admin/x")).value!.headers.get("x-middleware-next"), "1");
  const wrapped = a.result.auth((req) => Response.json({ email: req.auth?.user?.email ?? null }));
  const res = (await a.run(() => wrapped(request(a.jar, "/api/x")))).value!;
  assertEquals(await res.json(), { email: "ada@example.com" });
});

/** A Map-backed Auth.js adapter, shaped like `@auth/prisma-adapter`'s. */
function memoryAdapter(
  sessions = new Map<string, { sessionToken: string; userId: string; expires: Date }>(),
) {
  type Row = {
    id: string;
    email: string | null;
    emailVerified: Date | null;
    name: string | null;
    image: string | null;
  };
  const users = new Map<string, Row>();
  const accounts = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, { identifier: string; token: string; expires: Date }>();
  const adapter = {
    users,
    accounts,
    tokens,
    sessions,
    createUser(u: Row) {
      const row = { ...u, id: u.id ?? crypto.randomUUID() };
      users.set(row.id, row);
      return row;
    },
    getUser: (id: string) => users.get(id) ?? null,
    getUserByEmail: (email: string) => [...users.values()].find((u) => u.email === email) ?? null,
    getUserByAccount: (ref: { provider: string; providerAccountId: string }) => {
      const acc = accounts.get(`${ref.provider}:${ref.providerAccountId}`);
      return acc ? users.get(String(acc.userId)) ?? null : null;
    },
    updateUser(patch: Partial<Row> & { id: string }) {
      for (const key of Object.keys(patch)) {
        if (!["id", "email", "emailVerified", "name", "image"].includes(key)) {
          throw new Error(`unknown column ${key}`);
        }
      }
      const row = { ...users.get(patch.id)!, ...patch };
      users.set(row.id, row);
      return row;
    },
    linkAccount(account: Record<string, unknown>) {
      accounts.set(`${account.provider}:${account.providerAccountId}`, account);
    },
    createSession(s: { sessionToken: string; userId: string; expires: Date }) {
      sessions.set(s.sessionToken, s);
      return s;
    },
    getSessionAndUser(token: string) {
      const session = sessions.get(token);
      return session ? { session, user: users.get(session.userId)! } : null;
    },
    updateSession(s: { sessionToken: string; expires?: Date }) {
      const row = sessions.get(s.sessionToken);
      if (!row) return null;
      const next = { ...row, ...s, expires: s.expires ?? row.expires };
      sessions.set(row.sessionToken, next);
      return next;
    },
    deleteSession(token: string) {
      if (!sessions.delete(token)) throw new Error("Record to delete does not exist.");
    },
    createVerificationToken(t: { identifier: string; token: string; expires: Date }) {
      tokens.set(`${t.identifier}|${t.token}`, t);
    },
    useVerificationToken(ref: { identifier: string; token: string }) {
      const key = `${ref.identifier}|${ref.token}`;
      const row = tokens.get(key) ?? null;
      tokens.delete(key);
      return row;
    },
  };
  return adapter as typeof adapter & AuthJsAdapter;
}

Deno.test("next-auth adapter bridge: users, accounts, tokens and sessions on Auth.js rows", async () => {
  const raw = memoryAdapter();
  const warnings: string[] = [];
  const bridged = fromAuthJsAdapter(raw, {
    credentialsProviders: new Set(["credentials"]),
    warn: (m) => void warnings.push(m),
  });
  const user = await bridged.createUser({
    email: "a@b.co",
    emailVerified: 1_700_000_000,
    name: "A",
  });
  const row = raw.users.get(user.id)!;
  assertEquals(row.emailVerified?.getTime(), 1_700_000_000_000, "epoch seconds ↔ Date");
  assertEquals(user.emailVerified, 1_700_000_000);
  // denext-only fields never reach the Auth.js schema.
  const same = await bridged.updateUser({ id: user.id, sessionsValidAfter: 5, roles: ["x"] });
  assertEquals(same.id, user.id);
  await bridged.updateUser({ id: user.id, name: "B", bannedUntil: 9 });
  assertEquals(raw.users.get(user.id)!.name, "B");
  // A Credentials "account" is the user row itself, and links nothing.
  await bridged.linkAccount({
    userId: user.id,
    provider: "credentials",
    providerAccountId: user.id,
    type: "credentials",
  });
  assertEquals(raw.accounts.size, 0);
  assertEquals(
    (await bridged.getUserByAccount({ provider: "credentials", providerAccountId: user.id }))?.id,
    user.id,
  );
  await bridged.linkAccount({
    userId: user.id,
    provider: "github",
    providerAccountId: "77",
    type: "oauth",
    accessToken: "at",
  });
  assertEquals(raw.accounts.get("github:77")?.access_token, "at");
  assertEquals(
    (await bridged.getUserByAccount({ provider: "github", providerAccountId: "77" }))?.id,
    user.id,
  );
  // Verification tokens: keyed by purpose, single use.
  const expires = Math.floor(Date.now() / 1000) + 60;
  await bridged.createVerificationToken!({
    identifier: "a@b.co",
    tokenHash: "h1",
    expires,
    purpose: "magic",
  });
  assert(raw.tokens.has("magic:a@b.co|h1"));
  const used = await bridged.useVerificationToken!({
    identifier: "a@b.co",
    tokenHash: "h1",
    purpose: "magic",
  });
  assertEquals(used?.expires, expires);
  assertEquals(
    await bridged.useVerificationToken!({
      identifier: "a@b.co",
      tokenHash: "h1",
      purpose: "magic",
    }),
    undefined,
  );
  await assertRejects(async () =>
    await bridged.createVerificationToken!({
      identifier: "a@b.co",
      tokenHash: "h2",
      expires,
      purpose: "email_change" as "magic",
      data: "x",
    })
  );
  // Sessions.
  const store = bridged.sessions!;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  await store.create("sid-1", { user: { id: user.id }, provider: "credentials", expiresAt });
  assertEquals((await store.get("sid-1"))?.user.email, "a@b.co");
  assertEquals(
    await store.update!("sid-1", {
      user: { id: user.id },
      provider: "x",
      expiresAt: expiresAt + 10,
    }),
    true,
  );
  assertEquals(
    await store.update!("nope", { user: { id: user.id }, provider: "x", expiresAt }),
    false,
  );
  await store.delete("sid-1");
  await store.delete("sid-1"); // a missing row is already ended
  assertEquals(await store.get("sid-1"), undefined);
  await store.deleteByUser(user.id);
  assertEquals(warnings.length, 1, "deleteByUser can't be done and says so");
});

Deno.test("next-auth: database sessions through an Auth.js adapter", async () => {
  const sessions = new Map<string, { sessionToken: string; userId: string; expires: Date }>();
  const adapter = memoryAdapter(sessions);
  adapter.createUser({
    id: "u1",
    email: "ada@example.com",
    emailVerified: null,
    name: "Ada",
    image: null,
  });
  const a = app({ adapter, session: { strategy: "database" } });
  const res = await signInWithPassword(a);
  assertEquals(res.status, 302);
  assertEquals(sessions.size, 1, "a Session row");
  assertEquals([...sessions.values()][0].userId, "u1");
  const session = await (await a.call("/api/auth/session")).json();
  assertEquals(session.user.email, "ada@example.com");
  await a.call("/api/auth/signout", { form: { csrfToken: await a.csrf() } });
  assertEquals(sessions.size, 0, "sign-out deleted the row");
  assertEquals(await (await a.call("/api/auth/session")).json(), null);
});
