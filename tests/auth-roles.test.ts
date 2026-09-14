// Authorization on top of authentication: `requireAuth({ role })` and
// `requireSession({ role })` (any-of), the `callbacks.authorized` hook (a `false` refusal
// and a verbatim `Response`), and the MFA-pending session failing closed through `auth()`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createRequestContext,
  type RequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { auth, denextAuth, hasRole, requireAuth } from "../src/server/auth/mod.ts";
import { requireSession } from "../src/server/api-middleware.ts";
import { credentials } from "../src/server/auth/providers.ts";
import { type ApiError, isApiError } from "../src/server/api-error.ts";
import type { ApiMiddlewareInput } from "../src/server/define-api.ts";
import type { AuthConfig, AuthSession } from "../src/server/auth/types.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

/** Roles per test identity — `authorize` is the only place a role enters the session. */
const ROLES: Record<string, string[]> = {
  "root@x.test": ["admin", "editor"],
  "ed@x.test": ["editor"],
  "nobody@x.test": [],
};

function config(extra: Partial<AuthConfig> = {}): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    rateLimit: false,
    pages: { signIn: "/login" },
    providers: [
      credentials({
        authorize: ({ email }) => email in ROLES ? { id: email, email, roles: ROLES[email] } : null,
      }),
    ],
    ...extra,
  };
}

/** Sign in as `email` and return the `__Host-denext_auth=…` cookie pair. */
async function signIn(cfg: AuthConfig, email: string): Promise<string> {
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ORIGIN,
    },
    body: JSON.stringify({ email }),
  });
  const ctx = createRequestContext(request);
  const res = (await runWithContext(ctx, () => handleAuthRequest(request, cfg)))!;
  assertEquals(res.status, 200, await res.clone().text());
  const cookie = ctx.outgoingHeaders.getSetCookie()
    .find((c) => c.startsWith("__Host-denext_auth="))!;
  assert(cookie, "a session cookie was issued");
  return cookie.split(";")[0];
}

/** Run `body` inside a request context that carries `cookie` (if any). */
function asViewer<T>(
  cookie: string | undefined,
  body: (request: Request) => Promise<T>,
): Promise<T> {
  const request = new Request(`${ORIGIN}/dashboard?tab=1`, {
    headers: cookie ? { cookie } : {},
  });
  const ctx: RequestContext = createRequestContext(request);
  return runWithContext(ctx, () => body(request));
}

/** The 401/403 an `ApiMiddleware` threw, as an ApiError. */
async function middlewareError(
  cookie: string | undefined,
  options: Parameters<typeof requireSession>[0],
): Promise<ApiError | undefined> {
  return await asViewer(cookie, async (request) => {
    const input = { request } as unknown as ApiMiddlewareInput<object>;
    try {
      await requireSession(options)(input);
      return undefined;
    } catch (e) {
      return isApiError(e) ? e : undefined;
    }
  });
}

// ---- requireAuth({ role }) --------------------------------------------------

Deno.test("requireAuth({ role }): a held role passes; a missing one redirects with error=forbidden", async () => {
  const cfg = config();
  denextAuth(cfg);
  const admin = await signIn(cfg, "root@x.test");
  const editor = await signIn(cfg, "ed@x.test");

  assertEquals(
    await asViewer(admin, (r) => requireAuth(r, { role: "admin" })),
    null,
    "the admin passes",
  );

  const refused = await asViewer(editor, (r) => requireAuth(r, { role: "admin" }));
  assert(refused, "the editor is refused");
  assertEquals(refused.status, 302);
  const location = refused.headers.get("location")!;
  assertStringIncludes(location, "/login?error=forbidden");
  assertStringIncludes(decodeURIComponent(location), "/dashboard?tab=1");
});

Deno.test("requireAuth({ role }): any-of, and a session with no roles never satisfies one", async () => {
  const cfg = config();
  denextAuth(cfg);
  const editor = await signIn(cfg, "ed@x.test");
  const roleless = await signIn(cfg, "nobody@x.test");

  assertEquals(
    await asViewer(editor, (r) => requireAuth(r, { role: ["admin", "editor"] })),
    null,
    "any one of the listed roles suffices",
  );
  assert(
    await asViewer(editor, (r) => requireAuth(r, { role: ["admin", "owner"] })),
    "none of the listed roles → refused",
  );
  assert(
    await asViewer(roleless, (r) => requireAuth(r, { role: "admin" })),
    "no roles at all → refused",
  );
  assertEquals(
    await asViewer(roleless, (r) => requireAuth(r)),
    null,
    "no role requirement → unchanged behaviour",
  );
});

// ---- requireSession({ role }) -----------------------------------------------

Deno.test("requireSession({ role }): 401 when signed out, 403 when the role is missing, pass otherwise", async () => {
  const cfg = config();
  denextAuth(cfg);
  const admin = await signIn(cfg, "root@x.test");
  const editor = await signIn(cfg, "ed@x.test");

  const anonymous = await middlewareError(undefined, { role: "admin" });
  assertEquals([anonymous?.status, anonymous?.code], [401, "unauthorized"]);

  const forbidden = await middlewareError(editor, { role: "admin" });
  assertEquals([forbidden?.status, forbidden?.code], [403, "forbidden"]);
  assertEquals(forbidden?.message, "Forbidden");
  assertEquals(
    (await middlewareError(editor, { role: "admin", forbiddenMessage: "nope" }))?.message,
    "nope",
  );

  assertEquals(await middlewareError(admin, { role: "admin" }), undefined, "the admin passes");
  assertEquals(
    await middlewareError(editor, { role: ["admin", "editor"] }),
    undefined,
    "any-of",
  );
  assertEquals(await middlewareError(editor, {}), undefined, "no role requirement → unchanged");
});

// ---- callbacks.authorized ---------------------------------------------------

Deno.test("callbacks.authorized: false refuses like a missing session; a Response is returned verbatim", async () => {
  const denying = config({ callbacks: { authorized: () => false } });
  denextAuth(denying);
  const cookie = await signIn(denying, "root@x.test");
  const refused = await asViewer(cookie, (r) => requireAuth(r));
  assert(refused);
  assertEquals(refused.status, 302);
  const location = refused.headers.get("location")!;
  assertStringIncludes(location, "/login?callbackUrl=");
  assert(!location.includes("error="), "a plain refusal carries no error code");

  const own = config({
    callbacks: {
      authorized: ({ session, request }) => {
        assertEquals(session.user.id, "root@x.test");
        assertStringIncludes(request.url, "/dashboard");
        return new Response("teapot", { status: 418 });
      },
    },
  });
  denextAuth(own);
  const teapot = await asViewer(await signIn(own, "root@x.test"), (r) => requireAuth(r));
  assertEquals(teapot?.status, 418);
  assertEquals(await teapot!.text(), "teapot");
});

Deno.test("callbacks.authorized: it runs only for a live session, and a throw fails closed", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const cfg = config({
    callbacks: {
      authorized: () => {
        calls++;
        throw new Error("hook exploded");
      },
    },
    logger: { error: (_m, e) => void errors.push(e) },
  });
  denextAuth(cfg);

  const anonymous = await asViewer(undefined, (r) => requireAuth(r));
  assertEquals(anonymous?.status, 302);
  assertEquals(calls, 0, "no session → the hook is never asked");

  const refused = await asViewer(await signIn(cfg, "root@x.test"), (r) => requireAuth(r));
  assertEquals(refused?.status, 302, "a throwing hook refuses rather than 500s");
  assertEquals(calls, 1);
  assertEquals(errors.length, 1);
});

// ---- MFA-pending sessions fail closed ---------------------------------------

Deno.test("auth(): an MFA-pending session reads as signed out; requireAuth sends it to pages.mfa", async () => {
  const cfg = config({
    pages: { signIn: "/login", mfa: "/login/2fa" },
    callbacks: { session: (s) => ({ ...s, mfaPending: true as const }) },
  });
  denextAuth(cfg);
  const pending = await signIn(cfg, "root@x.test");

  assertEquals(
    await asViewer(pending, () => auth()),
    null,
    "auth() hides a half-authenticated session, so every guard built on it refuses",
  );

  const refused = await asViewer(pending, (r) => requireAuth(r));
  assert(refused);
  assertEquals(refused.status, 302);
  assertStringIncludes(refused.headers.get("location")!, "/login/2fa");

  // The API middleware inherits the refusal for free — it only ever sees `auth()`.
  const err = await middlewareError(pending, {});
  assertEquals([err?.status, err?.code], [401, "unauthorized"]);

  // Without a `pages.mfa`, the sign-in page is the fallback.
  const noMfaPage = config({
    callbacks: { session: (s) => ({ ...s, mfaPending: true as const }) },
  });
  denextAuth(noMfaPage);
  const back = await asViewer(await signIn(noMfaPage, "root@x.test"), (r) => requireAuth(r));
  assertStringIncludes(back!.headers.get("location")!, "/login?callbackUrl=");
});

Deno.test("hasRole: no requirement allows, but an EMPTY requirement refuses (fail closed)", () => {
  const session: AuthSession = {
    user: { id: "u1", roles: ["admin"] },
    provider: "credentials",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  assertEquals(hasRole(session, undefined), true, "no requirement at all");
  assertEquals(hasRole(session, "admin"), true);
  assertEquals(hasRole(session, ["editor", "admin"]), true, "any-of");
  // An empty list is a set of acceptable roles that is empty — nothing satisfies it. This
  // is what a computed `role: user.requiredRoles` degrades to when the computation breaks,
  // and it used to let every caller through.
  assertEquals(hasRole(session, []), false, "an empty requirement can never be satisfied");
  const roleless: AuthSession = { ...session, user: { id: "u2" } };
  assertEquals(hasRole(roleless, []), false);
  assertEquals(hasRole(roleless, undefined), true);
});
