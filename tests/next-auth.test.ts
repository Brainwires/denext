// The `next-auth` (Auth.js v5) shim: the config translation, the sealed token, the handlers'
// Auth.js endpoints, the server-side signIn / signOut, middleware, and the Auth.js adapter
// bridge. Security: every state-changing POST needs BOTH the same-origin check and the CSRF
// token, and a `redirect` callback can't send the browser off-origin.

import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
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
import Zoom from "../src/compat/next-auth/providers/zoom.ts";
import { translateConfig } from "../src/compat/next-auth/config.ts";
import { decode, encode, getToken } from "../src/compat/next-auth/jwt.ts";
import {
  type AuthJsAdapter,
  type AuthJsUserExtension,
  fromAuthJsAdapter,
} from "../src/compat/next-auth/adapter.ts";
import {
  auth as denextAuth,
  denextAuth as configureAuth,
  requireAuth,
  revokeAllSessions,
} from "../src/server/auth/mod.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { credentials } from "../src/server/auth/providers.ts";
import type { OAuthProvider } from "../src/server/auth/types.ts";
import { type CallInit, inRequest, Jar, ORIGIN, request } from "./helpers/next-auth-harness.ts";
import { isRedirect } from "../src/runtime/error-boundary.ts";

const SECRET = "next-auth-shim-test-secret-at-least-32-chars";

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

Deno.test("next-auth security: a jwt callback returning null at sign-in signs nobody in", async () => {
  // Auth.js's deny pattern: `if (user?.banned) return null` in `jwt`.
  const a = app({ callbacks: { jwt: ({ token, user }) => (user ? null : token) } });
  await signInWithPassword(a);
  assertEquals(await (await a.call("/api/auth/session")).json(), null);
  assertEquals((await a.run(() => a.result.auth())).value, null);
  // denext's own session reads (its auth endpoints, `requireSession`) see no session either.
  assertEquals((await a.run(() => denextAuth())).value, null);
});

Deno.test("next-auth security: an Object.prototype name in ?error= is an unknown code, not a 500", async () => {
  const { translateErrorLocation } = await import("../src/compat/next-auth/flows.ts");
  const a = app();
  for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    for (const path of [`/api/auth/error?error=${code}`, `/api/auth/signin?error=${code}`]) {
      const res = await a.call(path);
      assert(res.status < 500, `${path}: ${res.status}`);
      assert((await res.text()).includes("Unable to sign in."), path);
    }
    assertEquals(translateErrorLocation(`/x?error=${code}`), `/x?error=${code}`);
  }
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

Deno.test("next-auth: per-call authorizationParams reach the provider, the flow's own never", async () => {
  const a = app({ providers: [GitHub({ clientId: "id", clientSecret: "secret" })] });
  const query = new URLSearchParams({
    prompt: "login",
    login_hint: "ada@example.com",
    state: "attacker",
    redirect_uri: "https://evil.test/cb",
    Code_Challenge: "x",
    request_uri: "https://evil.test/req",
  });
  const res = await a.call(`/api/auth/signin/github?${query}`, {
    form: { csrfToken: await a.csrf(), callbackUrl: "/after" },
  });
  const to = new URL(res.headers.get("location")!);
  assertEquals(to.searchParams.get("prompt"), "login");
  assertEquals(to.searchParams.get("login_hint"), "ada@example.com");
  assertNotEquals(to.searchParams.get("state"), "attacker");
  assertEquals(to.searchParams.get("redirect_uri"), `${ORIGIN}/api/auth/callback/github`);
  assertNotEquals(to.searchParams.get("code_challenge"), "x");
  assertEquals(to.searchParams.has("Code_Challenge"), false);
  assertEquals(to.searchParams.has("request_uri"), false);

  // The server-side signIn() takes them as its third argument (a record or a query string).
  const server = await a.run(() =>
    a.result.signIn("github", { redirect: false }, { prompt: "consent", nonce: "n" })
  );
  const url = new URL(server.value!);
  assertEquals(url.searchParams.get("prompt"), "consent");
  assertNotEquals(url.searchParams.get("nonce"), "n");
  const asString = await a.run(() =>
    a.result.signIn("github", { redirect: false }, "access_type=offline&state=s")
  );
  const parsed = new URL(asString.value!);
  assertEquals(parsed.searchParams.get("access_type"), "offline");
  assertNotEquals(parsed.searchParams.get("state"), "s");
});

Deno.test("next-auth: a provider without scopes (Zoom) starts with none in the URL", async () => {
  const a = app({ providers: [Zoom({ clientId: "id", clientSecret: "secret" })] });
  const res = await a.call("/api/auth/signin/zoom", {
    form: { csrfToken: await a.csrf(), callbackUrl: "/after" },
  });
  const to = new URL(res.headers.get("location")!);
  assertEquals(to.origin + to.pathname, "https://zoom.us/oauth/authorize");
  assertEquals(to.searchParams.has("scope"), false);
  assertEquals(to.searchParams.get("code_challenge_method"), "S256");
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

/** A browser over any `NextAuth()` result (a lazy config's included), with extra headers. */
function browserFor(result: ReturnType<typeof NextAuth>, headers: Record<string, string> = {}) {
  const jar = new Jar();
  const call = async (path: string, init: CallInit = {}): Promise<Response> => {
    const req = request(jar, path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const handler = req.method === "GET" ? result.handlers.GET : result.handlers.POST;
    const { value, error } = await inRequest(req, jar, () => handler(req));
    if (error) throw error;
    jar.take(value!.headers);
    return value!;
  };
  const csrf = async () =>
    ((await (await call("/api/auth/csrf")).json()) as { csrfToken: string }).csrfToken;
  const signInAs = async (password: string) =>
    await call("/api/auth/callback/credentials", {
      form: { csrfToken: await csrf(), email: "ada@example.com", password, callbackUrl: "/home" },
    });
  return { jar, call, csrf, signInAs };
}

/** A config whose Credentials accept `pw-<tenant>`, its session naming the tenant. */
function tenantConfig(tenant: string, secret = SECRET): NextAuthConfig {
  return {
    secret,
    providers: [
      Credentials({
        authorize: (c) =>
          c.password === `pw-${tenant}` ? { id: `u-${tenant}`, name: tenant } : null,
      }),
    ],
    callbacks: { session: ({ session }) => ({ ...session, tenant }) },
  };
}

Deno.test("next-auth: a lazy config runs per request, with the request, and may be async", async () => {
  const seen: (string | undefined)[] = [];
  const tenants: Record<string, NextAuthConfig> = { a: tenantConfig("a"), b: tenantConfig("b") };
  const result = NextAuth(async (req) => {
    seen.push(req ? `${req.nextUrl.pathname}|${req.headers.get("x-tenant")}` : undefined);
    await Promise.resolve();
    return tenants[req?.headers.get("x-tenant") ?? "a"];
  });
  const b = browserFor(result, { "x-tenant": "b" });
  assertEquals((await b.signInAs("pw-a")).headers.get("location")?.includes("error="), true);
  assertEquals((await b.signInAs("pw-b")).headers.get("location"), "/home");
  assert(seen.includes("/api/auth/csrf|b"), "the handlers hand it the NextRequest");
  const session = await (await b.call("/api/auth/session")).json();
  assertEquals([session.user.name, session.tenant], ["b", "b"]);
  // `auth()` gets `undefined`, as in Auth.js (tenant "a" here).
  const read = await inRequest(request(b.jar, "/page"), b.jar, () => result.auth());
  assertEquals(seen.at(-1), undefined);
  assertEquals((read.value as unknown as Record<string, unknown>)?.tenant, "a");
});

Deno.test("next-auth: concurrent requests each read their own lazy config", async () => {
  const tenants: Record<string, NextAuthConfig> = {
    a: tenantConfig("a", `${SECRET}-tenant-a`),
    b: tenantConfig("b", `${SECRET}-tenant-b`),
  };
  const result = NextAuth(async (req) => {
    const tenant = req?.headers.get("x-tenant") ?? "a";
    // Tenant a resolves last, so tenant b's config is the process's latest while a runs.
    if (tenant === "a") await new Promise((r) => setTimeout(r, 20));
    return tenants[tenant];
  });
  const a = browserFor(result, { "x-tenant": "a" });
  const b = browserFor(result, { "x-tenant": "b" });
  await a.signInAs("pw-a");
  await b.signInAs("pw-b");
  const guarded = result.auth((req) => Response.json({ name: req.auth?.user?.name ?? null }));
  const read = (browser: typeof a, tenant: string) => {
    const req = request(browser.jar, "/api/me", { headers: { "x-tenant": tenant } });
    return inRequest(req, browser.jar, async () => await (await guarded(req)).json());
  };
  const [ra, rb] = await Promise.all([read(a, "a"), read(b, "b")]);
  assertEquals(ra.value, { name: "a" });
  assertEquals(rb.value, { name: "b" });
});

Deno.test("next-auth: a lazy config built fresh per request keeps one rate-limit budget", async () => {
  const result = NextAuth(() => tenantConfig("a"));
  const browser = browserFor(result);
  for (let i = 0; i < 5; i++) await browser.signInAs("wrong");
  const locked = await browser.signInAs("pw-a");
  assert(locked.headers.get("location")?.includes("error="), "locked out after 5 failures");
  assertEquals(await (await browser.call("/api/auth/session")).json(), null);
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
    roles: undefined, // an absent field is no write (and no warning)
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
  // Without the extension methods, the denext-only fields and the revocation can't be stored,
  // and each says so.
  assertEquals(warnings.length, 3);
  assert(warnings[0].includes("roles, sessionsValidAfter"), warnings[0]);
  assert(warnings[1].includes("bannedUntil"), warnings[1]);
  assert(warnings[2].includes("were not ended"), warnings[2]);
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

/** An email-provider app over the memory adapter, its sign-in links captured. */
function emailApp(config: Partial<NextAuthConfig> = {}) {
  const sent: { provider: string; url: string }[] = [];
  const adapter = memoryAdapter();
  const sender = (provider: string) => ({ url }: { url: string }) =>
    void sent.push({ provider, url });
  const a = app({
    adapter,
    session: { strategy: "jwt" },
    providers: [
      Resend({ confirm: false, sendVerificationRequest: sender("resend") }),
      Nodemailer({
        server: "smtp://u:p@mail.test:587",
        from: "a@app.test",
        confirm: false,
        sendVerificationRequest: sender("nodemailer"),
      }),
    ],
    ...config,
  });
  const requestLink = async (provider: string, email: string, callbackUrl = "/dash") => {
    await a.call(`/api/auth/signin/${provider}`, {
      form: { csrfToken: await a.csrf(), email, callbackUrl },
    });
    const link = new URL(sent.at(-1)!.url);
    return link.pathname + link.search;
  };
  return { ...a, adapter, sent, requestLink };
}

Deno.test("next-auth pages: a first sign-in lands on pages.newUser, a later one on callbackUrl", async () => {
  const a = emailApp({ pages: { newUser: "/welcome" } });
  const first = await a.call(await a.requestLink("resend", "new@example.com"));
  assertEquals(first.headers.get("location"), "/welcome?callbackUrl=%2Fdash");
  await a.call("/api/auth/signout", { form: { csrfToken: await a.csrf() } });
  const again = await a.call(await a.requestLink("resend", "new@example.com"));
  assertEquals(again.headers.get("location"), "/dash");
});

Deno.test("next-auth pages: GET signout goes to pages.signOut when the app has one", async () => {
  const own = app({ pages: { signOut: "/goodbye" } });
  const res = await own.call("/api/auth/signout");
  assertEquals([res.status, res.headers.get("location")], [302, "/goodbye"]);
  const builtIn = await app().call("/api/auth/signout");
  assertEquals(builtIn.status, 200);
  assert((await builtIn.text()).includes("Are you sure you want to sign out?"));
});

Deno.test("next-auth pages: the built-in GET pages redirect to the app's own, as Auth.js does", async () => {
  const a = app({
    pages: { signIn: "/login", error: "/oops?from=auth", verifyRequest: "/check-email" },
  });
  const signIn = await a.call("/api/auth/signin?callbackUrl=%2Fdash&error=CredentialsSignin");
  assertEquals(signIn.status, 302);
  assertEquals(
    signIn.headers.get("location"),
    "/login?callbackUrl=%2Fdash&error=CredentialsSignin",
  );
  // A foreign callbackUrl is kept on the origin, like every other one.
  const foreign = await a.call("/api/auth/signin?callbackUrl=https%3A%2F%2Fevil.test%2Fx");
  assertEquals(foreign.headers.get("location"), "/login?callbackUrl=%2F");
  const error = await a.call("/api/auth/error?error=AccessDenied");
  assertEquals(error.headers.get("location"), "/oops?from=auth&error=AccessDenied");
  const verify = await a.call("/api/auth/verify-request");
  assertEquals(verify.headers.get("location"), "/check-email");
});

Deno.test("next-auth pages: a custom page on another origin, or the endpoint itself, isn't followed", async () => {
  const a = app({
    pages: {
      signIn: "https://evil.test/login",
      error: "/api/auth/error",
      signOut: "//evil.test/bye",
    },
  });
  const signIn = await a.call("/api/auth/signin");
  assertEquals(signIn.status, 200, "the built-in page instead of an off-origin redirect");
  const error = await a.call("/api/auth/error?error=Configuration");
  assertEquals(error.status, 500, "the built-in error page, not a redirect loop");
  assertEquals((await a.call("/api/auth/signout")).status, 200);
});

Deno.test("next-auth email: each email provider sends its own links", async () => {
  const a = emailApp();
  await a.requestLink("nodemailer", "n@example.com");
  await a.requestLink("resend", "r@example.com");
  assertEquals(a.sent.map((m) => m.provider), ["nodemailer", "resend"]);
  assert(a.sent[0].url.includes("/api/auth/callback/nodemailer"));
});

Deno.test("next-auth events: session fires on every read, updateUser on a verifying sign-in", async () => {
  const sessions: unknown[] = [];
  const updated: unknown[] = [];
  const a = emailApp({
    events: {
      session: (message) => void sessions.push(message),
      updateUser: ({ user }) => void updated.push(user),
    },
  });
  // A user the adapter knows, its address not yet verified: the email sign-in verifies it.
  a.adapter.createUser({
    id: "known",
    email: "known@example.com",
    emailVerified: null,
    name: "Known",
    image: null,
  });
  await a.call(await a.requestLink("resend", "known@example.com"));
  assertEquals(updated.length, 1);
  assertEquals((updated[0] as { id: string }).id, "known");
  const session = await (await a.call("/api/auth/session")).json();
  assertEquals(session.user.id, "known");
  const event = sessions.at(-1) as { session: { user: { id: string } }; token?: { sub?: string } };
  assertEquals(event.session.user.id, "known");
  assertEquals(event.token?.sub, "known", "the JWT strategy hands the token too");
  const count = sessions.length;
  await a.run(() => a.result.auth());
  assertEquals(sessions.length, count + 1, "auth() fires it as well");
});

Deno.test("next-auth events: a throwing session listener never fails the read", async () => {
  const a = app({ events: { session: () => Promise.reject(new Error("listener broke")) } });
  await signInWithPassword(a);
  const session = await (await a.call("/api/auth/session")).json();
  assertEquals(session.user.email, "ada@example.com");
});

/** The adapter with an in-memory extension table beside its users, as an app would add one. */
function withExtensionTable<T extends object>(adapter: T) {
  const extensions = new Map<string, AuthJsUserExtension>();
  return Object.assign(adapter, {
    extensions,
    getUserExtension: (id: string) => extensions.get(id) ?? null,
    updateUserExtension: (id: string, patch: AuthJsUserExtension) =>
      void extensions.set(id, { ...extensions.get(id), ...patch }),
  });
}

Deno.test("next-auth adapter bridge: an extension table keeps roles, bans and sessionsValidAfter", async () => {
  const raw = withExtensionTable(memoryAdapter());
  const warnings: string[] = [];
  const bridged = fromAuthJsAdapter(raw, {
    credentialsProviders: new Set(["credentials"]),
    warn: (m) => void warnings.push(m),
  });
  const user = await bridged.createUser({ email: "a@b.co", roles: ["admin"] });
  assertEquals(raw.extensions.get(user.id), { roles: ["admin"] });
  assertEquals(user.roles, ["admin"]);
  assertEquals((await bridged.getUser(user.id))?.roles, ["admin"]);
  await bridged.updateUser({ id: user.id, bannedUntil: 99, sessionsValidAfter: 5 });
  const read = await bridged.getUserByEmail("a@b.co");
  assertEquals([read?.roles, read?.bannedUntil, read?.sessionsValidAfter], [["admin"], 99, 5]);
  await bridged.updateUser({ id: user.id, bannedUntil: undefined });
  assertEquals((await bridged.getUser(user.id))?.bannedUntil, undefined, "null clears it");
  assertEquals(Object.keys(raw.users.get(user.id)!).sort(), [
    "email",
    "emailVerified",
    "id",
    "image",
    "name",
  ]);
  const store = bridged.sessions!;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  await store.create("sid-1", { user: { id: user.id }, provider: "credentials", expiresAt });
  assertEquals((await store.get("sid-1"))?.user.roles, ["admin"], "a session carries the roles");
  await store.deleteByUser(user.id);
  assertEquals(warnings, [], "revocation goes through sessionsValidAfter instead");
});

Deno.test("next-auth: with an extension table, revokeAllSessions and a ban end database sessions", async () => {
  const sessions = new Map<string, { sessionToken: string; userId: string; expires: Date }>();
  const adapter = withExtensionTable(memoryAdapter(sessions));
  adapter.createUser({
    id: "u1",
    email: "ada@example.com",
    emailVerified: null,
    name: "Ada",
    image: null,
  });
  adapter.extensions.set("u1", { roles: ["editor"] });
  const a = app({ adapter, session: { strategy: "database" } });
  const readSession = async () => await (await a.call("/api/auth/session")).json();
  await signInWithPassword(a);
  assertEquals((await readSession())?.user.email, "ada@example.com");
  const guard = await a.run(() => requireAuth(new Request(`${ORIGIN}/admin`), { role: "editor" }));
  assertEquals(guard.value, null, "the stored role reaches the session");

  // Signed in a minute ago (a row's sign-in time is its expiry less maxAge), then revoked.
  for (const row of sessions.values()) row.expires = new Date(row.expires.getTime() - 60_000);
  await a.run(() => revokeAllSessions("u1"));
  assertEquals(await readSession(), null, "signed out everywhere");
  assertEquals(sessions.size, 0, "the dead row is deleted");

  await signInWithPassword(a);
  assertEquals((await readSession())?.user.email, "ada@example.com", "a new sign-in works");
  const until = Math.floor(Date.now() / 1000) + 3600;
  adapter.extensions.set("u1", { ...adapter.extensions.get("u1"), bannedUntil: until });
  assertEquals(await readSession(), null, "a ban ends the session");
});

Deno.test("next-auth adapter bridge: MFA is refused over its database sessions (no authTime / amr / pending state)", () => {
  // The bridge's session rows hold only the user and the expiry: a session still owing its
  // second factor would read back as a complete one. Any MFA over them is a config error.
  const memory = inMemoryAuthAdapter(); // the MFA factor store and backup codes
  const bridged = fromAuthJsAdapter(memoryAdapter(), {
    credentialsProviders: new Set(["credentials"]),
    warn: () => {},
  });
  assert(bridged.sessions, "the bridge stores database sessions");
  const base = {
    secret: "bridge-mfa-secret-at-least-32-characters!",
    canonicalOrigin: ORIGIN,
    providers: [credentials({ authorize: () => null })],
  };
  const withMfa = { ...memory, ...bridged };
  for (
    const config of [
      { ...base, adapter: withMfa, session: { strategy: "database" as const } },
      {
        ...base,
        adapter: withMfa,
        session: { strategy: "database" as const },
        mfa: { required: "always" as const },
      },
      // The bridge's store named explicitly, beside an adapter that has the factor store.
      { ...base, adapter: memory, sessionStore: bridged.sessions },
    ]
  ) {
    assertThrows(() => configureAuth(config), Error, "Auth.js adapter");
  }
});

Deno.test("next-auth: database sessions slide by updateAge, as Auth.js's do, up to session.maxLifetime", async () => {
  const sessions = new Map<string, { sessionToken: string; userId: string; expires: Date }>();
  const adapter = memoryAdapter(sessions);
  adapter.createUser({
    id: "u1",
    email: "ada@example.com",
    emailVerified: null,
    name: "Ada",
    image: null,
  });
  const a = app({
    adapter,
    session: { strategy: "database", maxAge: 3600, updateAge: 60, maxLifetime: 7200 },
  });
  const realNow = Date.now;
  const signedIn = realNow();
  const expiresOf = () => [...sessions.values()][0].expires.getTime();
  const readSession = async () => await (await a.call("/api/auth/session")).json();
  try {
    Date.now = () => signedIn;
    await signInWithPassword(a);
    assertEquals(sessions.size, 1);
    const first = expiresOf();
    assert(Math.abs(first - (signedIn + 3600_000)) < 1000, "the row lasts maxAge");

    // Younger than updateAge: the row is left alone.
    Date.now = () => signedIn + 30_000;
    assertEquals((await readSession())?.user.email, "ada@example.com");
    assertEquals(expiresOf(), first, "not stale yet");

    // Past updateAge: the row's expiry moves to a full maxAge from now (Auth.js's
    // `sessionUpdateTime`), keeping the same token.
    Date.now = () => signedIn + 120_000;
    const token = [...sessions.keys()][0];
    assertEquals((await readSession())?.user.email, "ada@example.com");
    assertEquals([...sessions.keys()], [token], "the same session row");
    assert(Math.abs(expiresOf() - (signedIn + 120_000 + 3600_000)) < 1000, "slid by a maxAge");

    // Near the ceiling a slide stops at sign-in + maxLifetime, not a full maxAge on.
    Date.now = () => signedIn + 3_700_000;
    const near = await readSession();
    assertEquals(near?.user.email, "ada@example.com");
    assert(Math.abs(expiresOf() - (signedIn + 7200_000)) < 1000, "capped at maxLifetime");
    assert(Math.abs(new Date(near.expires).getTime() - (signedIn + 7200_000)) < 1000);

    // Past the ceiling the session is over, however recently it slid.
    Date.now = () => signedIn + 7201_000;
    assertEquals(await readSession(), null, "ended at the ceiling");
  } finally {
    Date.now = realNow;
  }
});
