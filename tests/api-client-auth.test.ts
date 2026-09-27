// `createApiClient({ base, auth })` (a bearer provider, one retry after a single shared
// refresh) and the `nativeSession()` helper end to end against the real auth handler: browser
// sign-in through a simulated system sheet, single-flight refresh, sign-out and deletion.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ApiClientAuth,
  createApiClient,
  isApiClientError,
} from "../src/runtime/api-client.ts";
import { nativeSession, NativeSessionError } from "../src/runtime/native-session.ts";
import { inMemoryAuthAdapter } from "../src/server/auth/memory-adapter.ts";
import { auth, denextAuth } from "../src/server/auth/mod.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const BASE = "https://api.test";

// ---- createApiClient({ auth }) ----------------------------------------------------------

/** A server that accepts only `Bearer good-<n>` for the current n, counting what it saw. */
function server() {
  const state = { valid: "good-1", seen: [] as string[] };
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const authz = headers.get("authorization") ?? "";
    state.seen.push(`${String(input)} ${authz}`);
    if (authz !== `Bearer ${state.valid}`) {
      return Promise.resolve(
        Response.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 }),
      );
    }
    return Promise.resolve(Response.json({ ok: true, path: new URL(String(input)).pathname }));
  };
  return { state, fetch: fetchImpl as typeof fetch };
}

Deno.test("auth: every call carries the bearer token, against the remote base", async () => {
  const s = server();
  const api = createApiClient({ base: BASE, fetch: s.fetch, auth: { getToken: () => "good-1" } });
  assertEquals(await api("/api/me", "GET"), { ok: true, path: "/api/me" });
  assertEquals(s.state.seen, [`${BASE}/api/me Bearer good-1`]);
});

Deno.test("auth: a 401 is retried once after refresh; concurrent 401s share ONE refresh", async () => {
  const s = server();
  let token = "stale";
  let refreshes = 0;
  const provider: ApiClientAuth = {
    getToken: () => token,
    refresh: async () => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 5));
      token = "good-1";
      return token;
    },
  };
  const api = createApiClient({ base: BASE, fetch: s.fetch, auth: provider, dedupe: false });
  const results = await Promise.all([
    api("/api/a", "GET"),
    api("/api/b", "POST"),
    api("/api/c", "GET"),
  ]);
  assertEquals(results.map((r) => (r as { ok: boolean }).ok), [true, true, true]);
  assertEquals(refreshes, 1, "one refresh for three concurrent 401s");
});

Deno.test("auth: a failed refresh surfaces the original 401 (no loop); no refresh → no retry", async () => {
  const s = server();
  let refreshes = 0;
  const api = createApiClient({
    base: BASE,
    fetch: s.fetch,
    auth: {
      getToken: () => "stale",
      refresh: () => {
        refreshes++;
        return Promise.resolve(null);
      },
    },
  });
  const error = await assertRejects(() => api("/api/me", "GET"));
  assert(isApiClientError(error));
  assertEquals(error.status, 401);
  assertEquals(refreshes, 1);
  const noRefresh = createApiClient({ base: BASE, fetch: s.fetch, auth: { getToken: () => null } });
  await assertRejects(() => noRefresh("/api/me", "GET"));
  assertEquals(s.state.seen.at(-1), `${BASE}/api/me `, "no token → no Authorization header");
});

Deno.test("auth: a 401 for a token the provider already replaced retries without refreshing", async () => {
  const s = server();
  let token = "stale";
  let refreshes = 0;
  const api = createApiClient({
    base: BASE,
    fetch: ((input: string, init?: RequestInit) => {
      const res = s.fetch(input, init);
      token = "good-1"; // another call refreshed while this one was in flight
      return res;
    }) as typeof fetch,
    auth: {
      getToken: () => token,
      refresh: () => {
        refreshes++;
        return Promise.resolve("good-1");
      },
    },
  });
  assertEquals(await api("/api/me", "GET"), { ok: true, path: "/api/me" });
  assertEquals(refreshes, 0);
});

Deno.test("the options call signature still works without auth", async () => {
  const seen: string[] = [];
  const f = ((input: string) => {
    seen.push(String(input));
    return Promise.resolve(Response.json({ ok: 1 }));
  }) as typeof fetch;
  assertEquals(await createApiClient({ base: BASE, fetch: f, batch: false })("/api/x", "GET"), {
    ok: 1,
  });
  assertEquals(seen, [`${BASE}/api/x`]);
});

// ---- nativeSession() end to end -------------------------------------------------------------

const ORIGIN = "https://api.test";
const REDIRECT = "com.example.app://auth/callback";
const EMAIL = "n@x.test";
const PASSWORD = "correct horse battery staple";

async function app() {
  const adapter = inMemoryAuthAdapter();
  const user = await adapter.createUser({ email: EMAIL, emailVerified: 1 });
  await adapter.setCredential!(user.id, await hashPassword(PASSWORD));
  const config: AuthConfig = {
    secret: "test-secret-value-at-least-32-chars-long",
    canonicalOrigin: ORIGIN,
    trustForwardedHeaders: false,
    providers: [{ id: "credentials", type: "credentials" }],
    adapter,
    rateLimit: false,
    pages: { signIn: "/login" },
    native: { redirectUris: [REDIRECT] },
  };
  denextAuth(config);
  const posts: string[] = [];
  /** The server, reached over "HTTP" by the app (no Origin: a native client). */
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST") posts.push(new URL(request.url).pathname);
    const res = await runWithContext(
      createRequestContext(request),
      () => handleAuthRequest(request, config),
    );
    return res ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  /** The system browser sheet: authorize → password sign-in → complete; resolves the callback. */
  const open = async (url: string) => {
    const jar = new Map<string, string>();
    const hop = async (req: Request) => {
      if (jar.size) req.headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const ctx = createRequestContext(req);
      const res = await runWithContext(ctx, () => handleAuthRequest(req, config));
      for (const c of ctx.outgoingHeaders.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return res!;
    };
    await hop(new Request(url));
    await hop(
      new Request(`${ORIGIN}/auth/callback/credentials`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    const done = await hop(new Request(`${ORIGIN}/auth/native/complete`));
    return done.headers.get("location")!;
  };
  return { config, fetch: fetchImpl, open, posts, userId: user.id, adapter };
}

/** An in-memory stand-in for `secureStore`. */
function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    get: (k: string) => Promise.resolve(map.get(k) ?? null),
    set: (k: string, v: string) => Promise.resolve(void map.set(k, v)),
    delete: (k: string) => Promise.resolve(void map.delete(k)),
  };
}

Deno.test("nativeSession: sign in through the sheet, call the API, refresh once, sign out", async () => {
  const a = await app();
  const storage = memoryStore();
  const session = nativeSession({ base: ORIGIN, redirectUri: REDIRECT, storage, fetch: a.fetch });
  const user = await session.signIn(a.open);
  assertEquals(user.id, a.userId);
  assert(await session.signedIn());
  const token = await session.getToken();
  assert(token?.startsWith("nat_"));
  const request = new Request(`${ORIGIN}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(
    (await runWithContext(createRequestContext(request), () => auth()))?.user.id,
    a.userId,
  );

  // Two concurrent refreshes rotate ONCE (a second rotation would read as a replay).
  a.posts.length = 0;
  const [t1, t2] = await Promise.all([session.refresh(), session.refresh()]);
  assertEquals(t1, t2);
  assertEquals(a.posts, ["/auth/native/token"]);
  assert(await session.getToken());

  await session.signOut();
  assertEquals(await session.signedIn(), false);
  assertEquals(await session.getToken(), null);
  const after = new Request(`${ORIGIN}/api/me`, { headers: { authorization: `Bearer ${t1}` } });
  assertEquals(await runWithContext(createRequestContext(after), () => auth()), null);
});

Deno.test("nativeSession: a mismatched state is refused; deleteAccount removes the user", async () => {
  const a = await app();
  const session = nativeSession({
    base: ORIGIN,
    redirectUri: REDIRECT,
    storage: memoryStore(),
    fetch: a.fetch,
  });
  const error = await assertRejects(() =>
    session.signIn(async (url) => {
      const back = new URL(await a.open(url));
      back.searchParams.set("state", "forged");
      return back.href;
    })
  );
  assert(error instanceof NativeSessionError);
  assertEquals(error.code, "state_mismatch");

  await session.signIn(a.open);
  await session.deleteAccount();
  assertEquals(await a.adapter.getUser(a.userId), undefined);
  assertEquals(await session.signedIn(), false);
});

Deno.test("nativeSession as createApiClient's auth: 401 → refresh → retry", async () => {
  const a = await app();
  const session = nativeSession({
    base: ORIGIN,
    redirectUri: REDIRECT,
    storage: memoryStore(),
    fetch: a.fetch,
  });
  await session.signIn(a.open);
  let calls = 0;
  const apiFetch = (async (_input: string, init?: RequestInit) => {
    calls++;
    const bearer = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
    const req = new Request(`${ORIGIN}/api/me`, { headers: { authorization: `Bearer ${bearer}` } });
    const s = await runWithContext(createRequestContext(req), () => auth());
    // The first call is refused regardless, to force the refresh path.
    if (!s || calls === 1) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    return Response.json({ id: s.user.id });
  }) as typeof fetch;
  const api = createApiClient({ base: ORIGIN, fetch: apiFetch, auth: session });
  assertEquals(await api("/api/me", "GET"), { id: a.userId });
  assertEquals(calls, 2);
});
