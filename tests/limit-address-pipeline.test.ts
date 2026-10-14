// Per-address limits key on the same client through every request the pipeline builds from the
// client's: a typed-API batch item (a synthesized sub-request), a basePath strip and a config
// rewrite (the request rebuilt for its new URL). Each used to lose either the app's
// `rateLimitHeader` (the sub-request header allowlist dropped it) or the recorded socket peer
// (a rebuilt `Request` is a new WeakMap key) — and `rateLimit()`'s default key then skipped the
// limit, or shared one `unknown` bucket between every client.

import { assertEquals } from "@std/assert";
import { createApi } from "../src/server/define-api.ts";
import { rateLimit } from "../src/server/api-middleware.ts";
import { inMemoryRateLimitStore } from "../src/server/auth/rate-limit.ts";
import { parseCidr, setRemoteAddr } from "../src/server/remote-addr.ts";
import { synthesizeSubRequest } from "../src/server/sub-request.ts";
import { createRequestContext } from "../src/server/request-context.ts";
import { limitAddrOf } from "../src/server/remote-addr.ts";
import { API_BATCH_HEADER, API_BATCH_PATH } from "../src/runtime/api-batch-protocol.ts";
import { batchApp, ORIGIN } from "./helpers/batch-app.ts";

/** A loopback reverse proxy, listed as the trusted source of the app's limit header. */
const LOOPBACK_PROXY = [parseCidr("127.0.0.0/8")!, parseCidr("::1")!];

/** A `load` that serves every API route as a GET limited to one request per client per minute. */
function limitedLoad() {
  const store = inMemoryRateLimitStore();
  const GET = createApi().use(rateLimit({ max: 1, windowMs: 60_000, store })).define(
    {},
    () => "ok",
  );
  return (fp: string) =>
    Promise.resolve((fp === "page.tsx" ? { default: () => null } : { GET }) as never);
}

/** A batch POST of one `GET /api/hello` item from `peer`, with extra headers. */
function batchFrom(peer: string, headers: Record<string, string> = {}): Request {
  const request = new Request(`${ORIGIN}${API_BATCH_PATH}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "localhost",
      "content-type": "application/json",
      [API_BATCH_HEADER]: "1",
      ...headers,
    },
    body: JSON.stringify({ v: 1, items: [{ id: 0, m: "GET", p: "/api/hello" }] }),
  });
  setRemoteAddr(request, { transport: "tcp", hostname: peer, port: 1 });
  return request;
}

/** The single item's status from a batch response. */
async function itemStatus(res: Response): Promise<number> {
  assertEquals(res.status, 200);
  return (await res.json()).r[0].s;
}

Deno.test("batch item + rateLimitHeader behind a loopback proxy: each named client is limited", async () => {
  const app = batchApp({
    load: limitedLoad(),
    rateLimitHeader: "cf-connecting-ip",
    rateLimitTrustedProxies: ["127.0.0.1"],
  });
  const a = { "cf-connecting-ip": "203.0.113.9" };
  assertEquals(await itemStatus(await app(batchFrom("127.0.0.1", a))), 200);
  assertEquals(await itemStatus(await app(batchFrom("127.0.0.1", a))), 429, "the same client");
  const b = { "cf-connecting-ip": "203.0.113.10" };
  assertEquals(await itemStatus(await app(batchFrom("127.0.0.1", b))), 200, "another client");
});

Deno.test("batch item + trusted x-forwarded-for: the proxy's hop is limited", async () => {
  const app = batchApp({ load: limitedLoad(), trustForwardedHeaders: true });
  const hop = { "x-forwarded-for": "6.6.6.6, 198.51.100.4" };
  assertEquals(await itemStatus(await app(batchFrom("10.0.0.2", hop))), 200);
  assertEquals(await itemStatus(await app(batchFrom("10.0.0.2", hop))), 429);
});

Deno.test("batch item + rateLimitLocalAddresses: a LAN peer is limited by its own address", async () => {
  const app = batchApp({ load: limitedLoad(), rateLimitLocalAddresses: true });
  assertEquals(await itemStatus(await app(batchFrom("192.168.1.20"))), 200);
  assertEquals(await itemStatus(await app(batchFrom("192.168.1.20"))), 429);
  assertEquals(await itemStatus(await app(batchFrom("192.168.1.21"))), 200, "another peer");
});

Deno.test("synthesizeSubRequest: the child inherits the parent's rateLimitHeader value — a caller's extra header cannot replace it", () => {
  const policy = { header: "cf-connecting-ip", trustedProxies: LOOPBACK_PROXY };
  const parent = new Request(`${ORIGIN}/`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
  setRemoteAddr(parent, { transport: "tcp", hostname: "127.0.0.1", port: 1 });
  const parentCtx = createRequestContext(parent, undefined, { limitPolicy: policy });
  const child = (extraHeaders?: HeadersInit) =>
    synthesizeSubRequest({
      method: "GET",
      url: new URL(`${ORIGIN}/api/x`),
      parent,
      parentCtx,
      idSuffix: "#0",
      extraHeaders,
    });
  assertEquals(limitAddrOf(parent, false, policy), "203.0.113.9");
  assertEquals(limitAddrOf(child(), false, policy), "203.0.113.9");
  assertEquals(limitAddrOf(child({ "cf-connecting-ip": "1.2.3.4" }), false, policy), "203.0.113.9");
  // A parent without the header: a caller cannot supply one for it either.
  const bare = new Request(`${ORIGIN}/`);
  const bareChild = synthesizeSubRequest({
    method: "GET",
    url: new URL(`${ORIGIN}/api/x`),
    parent: bare,
    parentCtx: createRequestContext(bare, undefined, { limitPolicy: policy }),
    idSuffix: "#0",
    extraHeaders: { "cf-connecting-ip": "1.2.3.4" },
  });
  assertEquals(bareChild.headers.get("cf-connecting-ip"), null);
});

Deno.test("synthesizeSubRequest: a child of a request from an untrusted peer keys on that peer, not the header", async () => {
  const policy = { header: "cf-connecting-ip", trustedProxies: LOOPBACK_PROXY };
  const parent = new Request(`${ORIGIN}/`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
  setRemoteAddr(parent, { transport: "tcp", hostname: "198.51.100.200", port: 1 });
  const parentCtx = createRequestContext(parent, undefined, { limitPolicy: policy });
  const original = console.warn;
  console.warn = () => {};
  try {
    const child = synthesizeSubRequest({
      method: "GET",
      url: new URL(`${ORIGIN}/api/x`),
      parent,
      parentCtx,
      idSuffix: "#0",
      extraHeaders: { "cf-connecting-ip": "1.2.3.4" },
    });
    // The child carries the parent's header and peer, so it reaches the same verdict.
    assertEquals(limitAddrOf(parent, false, policy), "198.51.100.200");
    assertEquals(limitAddrOf(child, false, policy), "198.51.100.200");
    assertEquals(limitAddrOf(child, true, policy), "198.51.100.200", "trust-proxy adds no trust");
  } finally {
    console.warn = original;
  }
  // Through the batch endpoint: a direct client forging the header per request shares one bucket.
  const app = batchApp({
    load: limitedLoad(),
    rateLimitHeader: "cf-connecting-ip",
    rateLimitTrustedProxies: ["127.0.0.1"],
  });
  console.warn = () => {};
  try {
    const forged = (value: string) => batchFrom("198.51.100.201", { "cf-connecting-ip": value });
    assertEquals(await itemStatus(await app(forged("203.0.113.20"))), 200);
    assertEquals(
      await itemStatus(await app(forged("203.0.113.21"))),
      429,
      "a fresh header, same peer",
    );
  } finally {
    console.warn = original;
  }
});

/** A direct GET to `path` from `peer`. */
function getFrom(path: string, peer: string): Request {
  const request = new Request(`${ORIGIN}${path}`, { headers: { host: "localhost" } });
  setRemoteAddr(request, { transport: "tcp", hostname: peer, port: 1 });
  return request;
}

Deno.test("basePath: the routed request keeps the socket peer — each client has its own bucket", async () => {
  const app = batchApp({ load: limitedLoad(), basePath: "/app" });
  assertEquals((await app(getFrom("/app/api/hello", "198.51.100.1"))).status, 200);
  assertEquals((await app(getFrom("/app/api/hello", "198.51.100.2"))).status, 200, "not shared");
  assertEquals((await app(getFrom("/app/api/hello", "198.51.100.1"))).status, 429);
});

Deno.test("config rewrite: the rewritten request keeps the socket peer — each client has its own bucket", async () => {
  const app = batchApp({
    load: limitedLoad(),
    rewrites: [{ source: "/v1/hello", destination: "/api/hello" }],
  });
  assertEquals((await app(getFrom("/v1/hello", "198.51.100.1"))).status, 200);
  assertEquals((await app(getFrom("/v1/hello", "198.51.100.2"))).status, 200, "not shared");
  assertEquals((await app(getFrom("/v1/hello", "198.51.100.1"))).status, 429);
});
