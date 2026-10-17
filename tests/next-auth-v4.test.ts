// NextAuth.js v4's server API on the `next-auth` shim: `NextAuth(authOptions)` as an App Router
// route handler and a Pages API route (through @denext/pages-router's real `(req, res)` adapter),
// `NextAuth(req, res, authOptions)`, `getServerSession` in its three call forms, `next-auth/next`,
// and `next-auth/middleware`'s `withAuth` and default export. Security: the v4 endpoints keep
// both CSRF checks, a hostile callbackUrl stays on the origin, and the cookies keep denext's
// `__Host-` / `HttpOnly` / `Secure` / `SameSite=Lax` defaults.

import { assert, assertEquals, assertRejects } from "@std/assert";
import NextAuth, { getServerSession, type NextAuthOptions } from "../src/compat/next-auth/index.ts";
import NextAuthNext, {
  getServerSession as nextGetServerSession,
  unstable_getServerSession,
} from "../src/compat/next-auth/next.ts";
import withAuthDefault, {
  type NextRequestWithAuth,
  withAuth,
} from "../src/compat/next-auth/middleware.ts";
import CredentialsProvider from "../src/compat/next-auth/providers/credentials.ts";
import { runApiRoute } from "../packages/pages-router/src/api.ts";
import { setActiveNextAuth } from "../src/compat/next-auth/state.ts";
import {
  getCsrfToken as reactGetCsrfToken,
  getSession as reactGetSession,
} from "../src/compat/next-auth/react.ts";
import { type CallInit, inRequest, Jar, ORIGIN, request } from "./helpers/next-auth-harness.ts";

const SECRET = "next-auth-v4-shim-test-secret-at-least-32-chars";

/** What `authorize()` saw, per call. */
interface AuthorizeSeen {
  ip?: string;
  agent: string | null;
  query: Record<string, string>;
  body: Record<string, unknown>;
}

/** A v4 `authOptions`: Credentials plus the role-carrying jwt / session callbacks. */
function v4Options(seen: AuthorizeSeen[] = [], extra: Partial<NextAuthOptions> = {}) {
  const options: NextAuthOptions = {
    secret: SECRET,
    providers: [
      CredentialsProvider({
        name: "Credentials",
        credentials: { username: { label: "Username" }, password: { type: "password" } },
        authorize(credentials, req) {
          seen.push({
            ip: req.headers["x-forwarded-for"],
            agent: req.headers.get("user-agent"),
            query: req.query,
            body: req.body,
          });
          return credentials.username === "ada" && credentials.password === "pw"
            ? { id: "u1", name: "Ada", email: "ada@example.com", role: "admin" }
            : null;
        },
      }),
    ],
    callbacks: {
      jwt: (
        { token, user },
      ) => (user ? { ...token, role: (user as { role?: string }).role } : token),
      session: ({ session, token }) => ({ ...session, role: token.role }),
    },
    ...extra,
  };
  return options;
}

/** A browser against a v4 App Router handler (`export { handler as GET, handler as POST }`). */
function appRouter(options: NextAuthOptions) {
  const handler = NextAuth(options);
  const jar = new Jar();
  const call = async (path: string, init: CallInit = {}): Promise<Response> => {
    const req = request(jar, path, init);
    const ctx = { params: { nextauth: path.split("?")[0].split("/").slice(3) } };
    const { value, error } = await inRequest(req, jar, () => handler(req, ctx));
    if (error) throw error;
    jar.take(value!.headers);
    return value!;
  };
  const csrf = async () =>
    ((await (await call("/api/auth/csrf")).json()) as { csrfToken: string }).csrfToken;
  const run = <T>(fn: () => Promise<T>, path = "/page") => inRequest(request(jar, path), jar, fn);
  return { handler, jar, call, csrf, run };
}

/** A browser against a v4 Pages API route, served by @denext/pages-router's `(req, res)` adapter. */
function pagesApi(options: NextAuthOptions, direct = false) {
  const route = direct
    ? (req: unknown, res: unknown) => NextAuthNext(req as Request, res as never, options)
    : NextAuthNext(options);
  const jar = new Jar();
  const call = async (path: string, init: CallInit = {}): Promise<Response> => {
    const req = request(jar, path, init);
    const url = new URL(req.url);
    const nextauth = url.pathname.split("/").slice(3).join("/");
    const { value, error, cookies } = await inRequest(
      req,
      jar,
      () => runApiRoute({ default: route as never }, req, { nextauth }, url),
    );
    if (error) throw error;
    jar.take(value!.headers);
    // What the pipeline does with the context's cookies: they ride the API route's response.
    const headers = new Headers(value!.headers);
    for (const cookie of cookies.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(value!.body, { status: value!.status, headers });
  };
  const csrf = async () =>
    ((await (await call("/api/auth/csrf")).json()) as { csrfToken: string }).csrfToken;
  return { jar, call, csrf };
}

/** Sign in with the credentials form, as the built-in page posts it. */
async function signIn(
  b: { call: (p: string, i?: CallInit) => Promise<Response>; csrf: () => Promise<string> },
  password = "pw",
  callbackUrl = "/home",
  headers: Record<string, string> = {},
): Promise<Response> {
  return await b.call("/api/auth/callback/credentials?from=form", {
    form: { csrfToken: await b.csrf(), username: "ada", password, callbackUrl },
    headers,
  });
}

Deno.test("next-auth v4: NextAuth(authOptions) is an App Router GET / POST handler", async () => {
  const seen: AuthorizeSeen[] = [];
  const options = v4Options(seen);
  const b = appRouter(options);
  assertEquals(typeof b.handler, "function");
  assertEquals(typeof b.handler.handlers.GET, "function", "still v5's result");
  const providers = await (await b.call("/api/auth/providers")).json();
  assertEquals(providers.credentials.type, "credentials");
  const res = await signIn(b, "pw", "/home", {
    "x-forwarded-for": "203.0.113.9",
    "user-agent": "v4-test",
  });
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/home");
  const session = await (await b.call("/api/auth/session")).json();
  assertEquals(session.user.email, "ada@example.com");
  assertEquals(session.role, "admin", "jwt + session callbacks");
  // authorize(credentials, req) gets v4's req: an indexable header bag, query and body.
  assertEquals(seen.length, 1);
  assertEquals(seen[0].ip, "203.0.113.9");
  assertEquals(seen[0].agent, "v4-test");
  assertEquals(seen[0].query, { from: "form" });
  assertEquals(seen[0].body.username, "ada");
  // getServerSession(authOptions) reads the same instance's session.
  const read = await b.run(() => getServerSession(options));
  assertEquals((read.value as { role?: string }).role, "admin");
  assertEquals(read.value?.user?.name, "Ada");
});

Deno.test("next-auth v4: a Pages API route serves the endpoints through (req, res)", async () => {
  for (const direct of [false, true]) {
    const b = pagesApi(v4Options(), direct);
    const csrf = await b.call("/api/auth/csrf");
    assertEquals(csrf.status, 200);
    assert((await csrf.json()).csrfToken);
    const res = await signIn(b);
    assertEquals(res.status, 302, `direct=${direct}`);
    assertEquals(res.headers.get("location"), "/home");
    const cookie = res.headers.getSetCookie().find((c) => c.includes("denext_auth="));
    assert(cookie, "the session cookie is set");
    // denext's cookie defaults survive the Node-style response.
    assert(cookie.startsWith("__Host-denext_auth="), cookie);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      assert(cookie.includes(attr), `${attr} in ${cookie}`);
    }
    const session = await (await b.call("/api/auth/session")).json();
    assertEquals(session.user.email, "ada@example.com");
    // The built-in sign-in page renders through `res.end()`.
    const page = await b.call("/api/auth/signin");
    assertEquals(page.status, 200);
    assert((await page.text()).includes("csrfToken"));
  }
});

Deno.test("next-auth v4: the endpoints keep both CSRF checks and a same-origin callbackUrl", async () => {
  const b = pagesApi(v4Options());
  // No token: refused.
  const bare = await b.call("/api/auth/callback/credentials", {
    form: { username: "ada", password: "pw" },
  });
  assertEquals(bare.status, 403);
  // A valid token from another origin: refused too.
  const token = await b.csrf();
  const foreign = await b.call("/api/auth/signout", {
    form: { csrfToken: token },
    origin: "https://evil.test",
  });
  assertEquals(foreign.status, 403);
  // A hostile callbackUrl lands on the app's origin.
  const res = await signIn(b, "pw", "https://evil.test/steal");
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/");
  const encoded = await signIn(b, "pw", "//evil.test/x");
  assertEquals(encoded.headers.get("location"), "/");
  // Sign-out needs the token, then ends the session.
  const out = await b.call("/api/auth/signout", { form: { csrfToken: await b.csrf() } });
  assertEquals(out.status, 302);
  assertEquals(await (await b.call("/api/auth/session")).json(), null);
});

Deno.test("next-auth v4: getServerSession(req, res, authOptions) and its argument checks", async () => {
  const options = v4Options();
  const b = appRouter(options);
  await signIn(b);
  const cookie = b.jar.header();
  // getServerSideProps / an API route inside a request: the current request's session.
  const inside = await b.run(() =>
    nextGetServerSession(new Request(`${ORIGIN}/page`), { setHeader() {} }, options)
  );
  assertEquals(inside.value?.user?.email, "ada@example.com");
  // A Node-style req outside a request context: its own cookie.
  const outside = await unstable_getServerSession(
    { headers: { cookie, host: "app.test" }, url: "/page", method: "GET" },
    {},
    options,
  );
  assertEquals(outside?.user?.email, "ada@example.com");
  const anonymous = await getServerSession(
    { headers: { host: "app.test" }, url: "/page", method: "GET" },
    {},
    options,
  );
  assertEquals(anonymous, null);
  await assertRejects(
    // deno-lint-ignore no-explicit-any
    () => (getServerSession as any)(),
    TypeError,
    "getServerSession(authOptions)",
  );
});

Deno.test("next-auth v4: next-auth/react's getSession({ req }) reads the session in-process", async () => {
  const b = appRouter(v4Options());
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("no HTTP: the handlers answer in-process"));
  try {
    const req = new Request(`${ORIGIN}/legacy`);
    assertEquals((await b.run(() => reactGetSession({ req }))).value, null);
    // A token minted for getCsrfToken({ req }) is set on the current response.
    const minted = await b.run(() => reactGetCsrfToken({ req }));
    assert(minted.value);
    assert(minted.cookies.getSetCookie().some((c) => c.includes("authjs.csrf-token=")));
    await signIn(b);
    const read = await b.run(() => reactGetSession({ ctx: { req } }));
    assertEquals((read.value as { role?: string } | null)?.role, "admin");
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("next-auth v4: the middleware default export gates on the session", async () => {
  const options = v4Options();
  const b = appRouter(options);
  const gate = (path: string) =>
    b.run(() => withAuthDefault(new Request(`${ORIGIN}${path}`), {}), path);
  const anon = (await gate("/dashboard?tab=1")).value as Response;
  assertEquals(anon.status, 307);
  const to = new URL(anon.headers.get("location")!);
  assertEquals(to.origin, ORIGIN);
  assertEquals(to.pathname, "/api/auth/signin");
  assertEquals(to.searchParams.get("callbackUrl"), "/dashboard?tab=1");
  // The auth endpoints and assets are never gated.
  assertEquals((await gate("/api/auth/session")).value, undefined);
  assertEquals((await gate("/_next/static/x.js")).value, undefined);
  assertEquals((await gate("/_denext/client.js")).value, undefined);
  // …on a path-segment boundary: a look-alike of an ungated prefix is still gated.
  for (const lookAlike of ["/api/authz/admin", "/_nextsecret", "/favicon.ico.bak"]) {
    assertEquals(((await gate(lookAlike)).value as Response).status, 307, lookAlike);
  }
  await signIn(b);
  assertEquals((await gate("/dashboard")).value, undefined, "a session continues");
});

Deno.test("next-auth v4: withAuth options, callbacks.authorized and a wrapped middleware", async () => {
  const options = v4Options();
  const b = appRouter(options);
  const tokens: unknown[] = [];
  const guarded = withAuth(
    (req: NextRequestWithAuth) => {
      tokens.push(req.nextauth.token?.role);
      return new Response("inner", { headers: { "x-inner": "1" } });
    },
    {
      pages: { signIn: "/login" },
      callbacks: { authorized: ({ token }) => token?.role === "admin" },
    },
  );
  const anon = (await b.run(() => guarded(new Request(`${ORIGIN}/admin`)))).value!;
  assertEquals(anon!.status, 307);
  assertEquals(new URL(anon!.headers.get("location")!).pathname, "/login");
  // The sign-in page itself is never gated (no redirect loop).
  assertEquals((await b.run(() => guarded(new Request(`${ORIGIN}/login`)))).value, undefined);
  await signIn(b);
  const ok = (await b.run(() => guarded(new Request(`${ORIGIN}/admin`)))).value!;
  assertEquals(ok!.headers.get("x-inner"), "1");
  assertEquals(tokens, ["admin"], "req.nextauth.token is the jwt callback's token");
  // Options alone: a role check refusing this user.
  const editorsOnly = withAuth({ callbacks: { authorized: ({ token }) => token?.role === "ed" } });
  const refused = (await b.run(() => editorsOnly(new Request(`${ORIGIN}/x`)))).value!;
  assertEquals(refused!.status, 307);
});

Deno.test("next-auth v4: withAuth reads a token before NextAuth() ran, and needs a secret", async () => {
  const b = appRouter(v4Options());
  await signIn(b);
  // A fresh process state: no instance yet (middleware loads before the auth route).
  setActiveNextAuth(null as never);
  const prior = Deno.env.get("NEXTAUTH_SECRET");
  try {
    Deno.env.delete("NEXTAUTH_SECRET");
    Deno.env.delete("AUTH_SECRET");
    const none = (await b.run(() => withAuthDefault(new Request(`${ORIGIN}/x`)))).value!;
    assertEquals(none!.status, 307);
    const to = new URL(none!.headers.get("location")!);
    assertEquals(to.pathname, "/api/auth/error");
    assertEquals(to.searchParams.get("error"), "Configuration");
    Deno.env.set("NEXTAUTH_SECRET", SECRET);
    const read = (await b.run(() => withAuthDefault(new Request(`${ORIGIN}/x`)))).value;
    assertEquals(read, undefined, "the token opens with NEXTAUTH_SECRET alone");
    const wrong = withAuth({ secret: "another-secret-that-is-at-least-32-characters" });
    const refused = (await b.run(() => wrong(new Request(`${ORIGIN}/x`)))).value!;
    assertEquals(refused!.status, 307, "a token sealed under another secret is no token");
  } finally {
    if (prior === undefined) Deno.env.delete("NEXTAUTH_SECRET");
    else Deno.env.set("NEXTAUTH_SECRET", prior);
  }
});

Deno.test("next-auth v4: a Node-style (req, res) with a bare res, a raw body, no pipeline", async () => {
  const handler = NextAuth(v4Options());
  const written: { status: number; headers: Record<string, unknown>; body: string } = {
    status: 0,
    headers: {},
    body: "",
  };
  const res = {
    set statusCode(code: number) {
      written.status = code;
    },
    setHeader(name: string, value: string | string[]) {
      written.headers[name] = value;
    },
    end(body?: string) {
      written.body = body ?? "";
    },
  };
  // Outside a request context the origin comes from the request's own headers.
  const headers = { host: "app.test", "x-forwarded-proto": "https", accept: ["application/json"] };
  assertEquals(
    await handler({ method: "GET", url: "/api/auth/providers", headers }, res),
    undefined,
  );
  assertEquals(written.status, 200);
  const providers = JSON.parse(written.body);
  assertEquals(providers.credentials.signinUrl, `${ORIGIN}/api/auth/signin/credentials`);
  assertEquals(written.headers["content-type"], "application/json; charset=utf-8");
  // A body the route left as text keeps its own content type (and still needs the token).
  const jar = new Jar();
  const raw = {
    method: "POST",
    url: "/api/auth/signout",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: "csrfToken=forged",
  };
  await inRequest(request(jar, "/api/auth/signout", { form: {} }), jar, () => handler(raw, res));
  assertEquals(written.status, 403);
});
