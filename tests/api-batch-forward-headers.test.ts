// Typed-API batching forwards an allowlisted request header per item (`apiBatch.forwardHeaders`
// on the server, `createApiClient({ batch: { forwardHeaders } })` on the client): each item's
// handler sees its OWN value — never another item's, never the batch request's — while a header
// the app does not list still sends the call alone. Credential, framing, trust and proxy headers
// can never be forwarded, and a value that could split or end a header fails the whole batch.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { ApiModule } from "../src/server/types.ts";
import type { DenextConfig } from "../src/server/config.ts";
import { json } from "../src/server/typed-response.ts";
import {
  API_BATCH_HEADER,
  API_BATCH_PATH,
  forwardableBatchHeaders,
  isBatchHeaderValue,
  isForwardableBatchHeader,
} from "../src/runtime/api-batch-protocol.ts";
import { createApiClient } from "../src/runtime/api-client.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";

const ORIGIN = "http://localhost";

/** The request headers a handler saw that this suite cares about. */
const SEEN = ["x-tenant", "x-locale", "cookie", "authorization", "x-forwarded-for", "x-other"];

/** An app whose `/api/echo` reports the headers it saw, and logs each call. */
function echoApp(apiBatch: DenextConfig["apiBatch"], extra: Record<string, unknown> = {}) {
  const calls: Record<string, string | null>[] = [];
  const echo = (req: Request) => {
    const seen = Object.fromEntries(SEEN.map((n) => [n, req.headers.get(n)]));
    calls.push(seen);
    return json(seen);
  };
  const routes: Record<string, ApiModule> = {
    "echo.ts": { GET: echo, POST: echo },
  } as Record<string, ApiModule>;
  const manifest: RouteManifest = {
    pages: [],
    api: [{
      kind: "api",
      pattern: parsePattern("/api/echo"),
      routePath: "/api/echo",
      filePath: "echo.ts",
    }],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  const app = createApp({
    getManifest: () => manifest,
    load: (fp: string) => Promise.resolve(routes[fp] as unknown as Record<string, unknown>),
    apiBatch,
    ...extra,
  });
  return { app, calls };
}

function batch(items: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${API_BATCH_PATH}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "localhost",
      cookie: "session=outer",
      authorization: "Bearer outer",
      "content-type": "application/json",
      [API_BATCH_HEADER]: "1",
      ...headers,
    },
    body: JSON.stringify({ v: 1, items }),
  });
}

/** The parsed body of each item result, by id. */
async function bodies(res: Response): Promise<Record<string, string | null>[]> {
  assertEquals(res.status, 200);
  const { r } = await res.json() as { r: { id: number; s: number; t: string }[] };
  return r.map((x) => {
    assertEquals(x.s, 200);
    return JSON.parse(x.t);
  });
}

Deno.test("api batch forwardHeaders: each item's handler sees its own value, never another's", async () => {
  const { app } = echoApp({ forwardHeaders: ["X-Tenant", "x-locale"] });
  const seen = await bodies(
    await app(batch([
      { id: 0, m: "GET", p: "/api/echo", h: { "x-tenant": "acme" } },
      { id: 1, m: "GET", p: "/api/echo", h: { "x-tenant": "globex", "x-locale": "fr" } },
      { id: 2, m: "GET", p: "/api/echo" },
      { id: 3, m: "POST", p: "/api/echo", b: "{}", h: { "x-tenant": "initech" } },
    ], { "x-tenant": "from-the-batch-request" })),
  );
  assertEquals(seen.map((s) => s["x-tenant"]), ["acme", "globex", null, "initech"]);
  assertEquals(seen.map((s) => s["x-locale"]), [null, "fr", null, null]);
  // The credentials every item inherits come from the batch request, unchanged.
  for (const s of seen) {
    assertEquals([s.cookie, s.authorization], ["session=outer", "Bearer outer"]);
  }
});

Deno.test("api batch forwardHeaders: an unlisted header, or none configured, fails the whole batch", async () => {
  for (const apiBatch of [{ forwardHeaders: ["x-tenant"] }, {}]) {
    const { app, calls } = echoApp(apiBatch);
    const res = await app(batch([
      { id: 0, m: "GET", p: "/api/echo" },
      { id: 1, m: "GET", p: "/api/echo", h: { "x-other": "1" } },
    ]));
    assertEquals(res.status, 400, JSON.stringify(apiBatch));
    await res.body?.cancel();
    assertEquals(calls, [], "nothing ran");
  }
  // A read never carried item headers before: x-tenant without the config is refused too.
  const { app } = echoApp(undefined);
  const res = await app(batch([{ id: 0, m: "GET", p: "/api/echo", h: { "x-tenant": "a" } }]));
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("api batch forwardHeaders: header injection and smuggling are refused (whole batch 400)", async () => {
  const { app, calls } = echoApp({ forwardHeaders: ["x-tenant"] });
  const bad: unknown[] = [
    { "x-tenant": "acme\r\nx-forwarded-for: 6.6.6.6" }, // CRLF: a second header
    { "x-tenant": "acme\nx-other: 1" },
    { "x-tenant": "acme\r" },
    { "x-tenant": "ac\u0000me" },
    { "x-tenant": "\tacme" }, // leading whitespace
    { "x-tenant": "acme " }, // trailing whitespace
    { "x-tenant": "a".repeat(1025) },
    { "x-tenant": "Ā" }, // not a byte string
    { "x-tenant": 7 },
    { "x-tenant": ["a", "b"] },
    { "X-Tenant": "acme" }, // keys are exact lower-case names
    { "x-tenant ": "acme" },
    JSON.parse('{"__proto__": "x"}'),
    { cookie: "session=evil" }, // credentials stay the batch request's
    { authorization: "Bearer evil" },
    { host: "evil.example" },
    { "x-forwarded-for": "6.6.6.6" },
    { "x-denext-batch-item": "0" },
    { "content-length": "0" },
    [], // not an object
    "x-tenant: acme",
  ];
  for (const h of bad) {
    const res = await app(batch([{ id: 0, m: "GET", p: "/api/echo", h }]));
    assertEquals(res.status, 400, JSON.stringify(h));
    await res.body?.cancel();
  }
  assertEquals(calls, [], "nothing ran");
  // The longest accepted value, and inner spaces, are fine.
  const ok = await bodies(
    await app(batch([
      { id: 0, m: "GET", p: "/api/echo", h: { "x-tenant": "a".repeat(1024) } },
      { id: 1, m: "GET", p: "/api/echo", h: { "x-tenant": "acme corp\tinc" } },
    ])),
  );
  assertEquals(ok[1]["x-tenant"], "acme corp\tinc");
});

Deno.test("api batch forwardHeaders: a credential, framing or proxy name in the list is never forwarded", async () => {
  // Even when a config skipped validation, the handler drops what may not be forwarded.
  const { app, calls } = echoApp(
    { forwardHeaders: ["cookie", "authorization", "x-forwarded-for", "x-client-addr", "x-tenant"] },
    { rateLimitHeader: "x-client-addr" },
  );
  for (const h of [{ cookie: "a=1" }, { authorization: "Bearer x" }, { "x-forwarded-for": "1" }]) {
    const res = await app(batch([{ id: 0, m: "GET", p: "/api/echo", h }]));
    assertEquals(res.status, 400, JSON.stringify(h));
    await res.body?.cancel();
  }
  const limited = await app(
    batch([{ id: 0, m: "GET", p: "/api/echo", h: { "x-client-addr": "1" } }]),
  );
  assertEquals(limited.status, 400, "the app's rateLimitHeader comes from the batch request alone");
  await limited.body?.cancel();
  assertEquals(calls, []);
});

Deno.test("api batch forwardHeaders: config validation names what cannot be forwarded", () => {
  validateDenextConfig({ apiBatch: { forwardHeaders: ["x-tenant", "X-Locale"] } } as DenextConfig);
  for (
    const name of [
      "cookie",
      "Authorization",
      "host",
      "connection",
      "transfer-encoding",
      "origin",
      "x-forwarded-for",
      "forwarded",
      "x-real-ip",
      "cf-connecting-ip",
      "proxy-authorization",
      "sec-fetch-site",
      "x-denext-batch-item",
      "x-csrf-token",
      "bad name",
      "",
      7,
    ]
  ) {
    assertThrows(
      () => validateDenextConfig({ apiBatch: { forwardHeaders: [name] } } as never),
      Error,
      "apiBatch.forwardHeaders",
      String(name),
    );
  }
  assertThrows(
    () =>
      validateDenextConfig(
        {
          rateLimitHeader: "x-client-addr",
          apiBatch: { forwardHeaders: ["x-client-addr"] },
        } as never,
      ),
    Error,
    "apiBatch.forwardHeaders",
  );
  assertThrows(
    () => validateDenextConfig({ apiBatch: { forwardHeaders: "x-tenant" } } as never),
    Error,
    "must be an array",
  );
});

Deno.test("api batch protocol: the forwardable-name and header-value rules", () => {
  assert(isForwardableBatchHeader("x-tenant"));
  assert(!isForwardableBatchHeader("X-Tenant"), "names are compared lower-case");
  assertEquals([...forwardableBatchHeaders(["X-Tenant", "cookie", 3, "x-tenant", "x-locale"])], [
    "x-tenant",
    "x-locale",
  ]);
  assert(isBatchHeaderValue(""));
  assert(isBatchHeaderValue("a b"));
  assert(!isBatchHeaderValue("a\r\nb"));
  assert(!isBatchHeaderValue(" a"));
});

// ── The client ───────────────────────────────────────────────────────────────

/** Pretend to be a browser bundle: hide the server's context bridge for the duration. */
async function asBrowser(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { __denextCurrentRequestContext?: unknown };
  const bridge = g.__denextCurrentRequestContext;
  delete g.__denextCurrentRequestContext;
  try {
    await fn();
  } finally {
    g.__denextCurrentRequestContext = bridge;
  }
}

/** A fetch that serves the app in-process and records each request it saw. */
function appFetch(app: (r: Request) => Promise<Response>, seen: Request[]): typeof fetch {
  return ((input: string, init?: RequestInit) => {
    const req = new Request(new URL(input, ORIGIN), {
      ...init,
      headers: {
        origin: ORIGIN,
        host: "localhost",
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    });
    seen.push(req.clone());
    return app(req);
  }) as typeof fetch;
}

type Echo = Record<string, string | null>;
type S = { "/api/echo": { GET: { response: Echo }; POST: { body: unknown; response: Echo } } };

Deno.test("client forwardHeaders: calls carrying x-tenant ride ONE batch, each with its own value", () =>
  asBrowser(async () => {
    const { app } = echoApp({ forwardHeaders: ["x-tenant"] });
    const seen: Request[] = [];
    const api = createApiClient<S>({
      fetch: appFetch(app, seen),
      batch: { forwardHeaders: ["X-Tenant"] },
    });
    const results = await Promise.all([
      api("/api/echo", "GET", { headers: { "x-tenant": "acme" } }),
      api("/api/echo", "GET", { headers: { "X-Tenant": "globex" } }),
      api("/api/echo", "GET"),
      api("/api/echo", "POST", { body: {}, headers: { "x-tenant": "initech" } }),
    ]);
    assertEquals(seen.length, 1, "one round trip");
    assertEquals(new URL(seen[0].url).pathname, API_BATCH_PATH);
    assertEquals(results.map((r) => r["x-tenant"]), ["acme", "globex", null, "initech"]);
  }));

Deno.test("client forwardHeaders: an unlisted header, a refused name or an oversize value goes alone", () =>
  asBrowser(async () => {
    const { app } = echoApp({ forwardHeaders: ["x-tenant"] });
    const seen: Request[] = [];
    const api = createApiClient<S>({
      fetch: appFetch(app, seen),
      batch: { forwardHeaders: ["x-tenant", "cookie"] },
    });
    const [other, cookie, long] = await Promise.all([
      api("/api/echo", "GET", { headers: { "x-other": "1" } }),
      api("/api/echo", "GET", { headers: { cookie: "a=1" } }),
      api("/api/echo", "GET", { headers: { "x-tenant": "a".repeat(1025) } }),
      api("/api/echo", "GET", { headers: { "x-tenant": "acme" } }),
      api("/api/echo", "GET", { headers: { "x-tenant": "globex" } }),
    ]);
    const paths = seen.map((r) => new URL(r.url).pathname).sort();
    assertEquals(paths, [API_BATCH_PATH, "/api/echo", "/api/echo", "/api/echo"]);
    assertEquals(other["x-other"], "1", "sent alone, with its header");
    assertEquals(cookie.cookie, "a=1");
    assertEquals(long["x-tenant"]?.length, 1025);

    // A client that lists nothing sends an x-tenant call alone, as before.
    seen.length = 0;
    const plain = createApiClient<S>({ fetch: appFetch(app, seen) });
    await Promise.all([
      plain("/api/echo", "GET", { headers: { "x-tenant": "acme" } }),
      plain("/api/echo", "GET"),
    ]);
    assertEquals(seen.length, 2);
  }));

Deno.test("client: a read with a body, or an empty forwardHeaders config, goes alone", () =>
  asBrowser(async () => {
    const { app } = echoApp({});
    validateDenextConfig({ apiBatch: {} } as DenextConfig);
    const seen: Request[] = [];
    const api = createApiClient({ fetch: appFetch(app, seen), batch: { forwardHeaders: [] } });
    await Promise.all([
      api("/api/echo" as never, "GET" as never, { body: {} } as never),
      api("/api/echo" as never, "GET" as never, { headers: { "x-tenant": "a" } } as never),
    ]).catch(() => {});
    // (A GET with a body is refused by `fetch` itself; what matters is that it never batched.)
    assertEquals(seen.filter((r) => new URL(r.url).pathname === API_BATCH_PATH), []);
  }));
