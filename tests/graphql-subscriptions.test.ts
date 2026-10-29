// @denext/graphql subscriptions: `fromChannel` runs the channel's `authorize` (with the Live
// socket's context and key, lazy re-authorization and revocation), GraphQL over WebSocket (the
// `graphql-ws` protocol, driven here by the real `graphql-ws` client), and the dev schema reload.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createClient } from "graphql-ws";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import {
  applyPlugins,
  getPluginRequestHandler,
  resetPlugins,
  runMatchingPrepareSteps,
} from "../src/plugin/mod.ts";
import {
  createChannel,
  inMemoryChannelTransport,
  setChannelTransport,
} from "../src/runtime/channel.ts";
import {
  createRequestContext,
  type RequestContextTrust,
  runWithContext,
} from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { createSchema, fromChannel, graphql } from "../packages/graphql/mod.ts";
import { releaseFetchBodies } from "./helpers/unread-bodies.ts";

// graphql-yoga's parse / validate caches (lru-cache) memoize their clock for 1 ms behind a timer:
// let it fire inside each test rather than after it.
Deno.test.afterEach(() => new Promise((r) => setTimeout(r, 10)));

// Responses read only for their status or headers are released when each test ends.
releaseFetchBodies();

type Msg = { text: string };

const uid = (cookie: string) => /uid=(\w+)/.exec(cookie)?.[1];
const peers: string[] = [];
let allowRooms = true;

const rooms = createChannel<Msg>({
  id: "gqls:rooms",
  authTtlSeconds: 0.001, // every payload after the first millisecond is re-checked
  authorize: (ctx) => {
    peers.push(ctx.peerId);
    return allowRooms;
  },
});
// A per-user channel: the key comes from a client-supplied argument, `authorize` checks it.
const inbox = createChannel<Msg>({
  id: "gqls:inbox",
  authorize: (ctx, key) => key === `user:${uid(ctx.cookie)}`,
});

/** Resolved each time a `subscribe` resolver has its channel attached. */
let attached = Promise.withResolvers<void>();

const schemaFor = (hello: string) =>
  createSchema<{ auth?: string | null }>({
    typeDefs: `
    type Query { hello: String!, auth: String, self: Query }
    type Msg { text: String! }
    type Subscription { room(name: String!): Msg!, inbox(user: String!): Msg! }
  `,
    resolvers: {
      Query: { hello: () => hello, auth: (_r, _a, ctx) => ctx.auth ?? null, self: () => ({}) },
      Subscription: {
        room: {
          subscribe: async (_r, { name }: { name: string }) => {
            const it = await fromChannel(rooms, name);
            attached.resolve();
            return it;
          },
          resolve: (p: Msg) => p,
        },
        inbox: {
          subscribe: async (_r, { user }: { user: string }) => {
            const it = await fromChannel(inbox, `user:${user}`);
            attached.resolve();
            return it;
          },
          resolve: (p: Msg) => p,
        },
      },
    },
  });
const schema = schemaFor("world");

const noopLoad = (() => Promise.resolve({})) as unknown as ModuleLoader;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Mount the plugin behind a real server (each request in its own denext request context). */
async function serve(
  options: Partial<Parameters<typeof graphql>[0]> = {},
  mode: "dev" | "prod" = "prod",
  load: ModuleLoader = noopLoad,
  trust: RequestContextTrust = {},
  appConfig: Partial<DenextConfig> = {},
) {
  resetPlugins();
  setChannelTransport(inMemoryChannelTransport());
  allowRooms = true;
  peers.length = 0;
  await applyPlugins({
    projectRoot: "/tmp/proj",
    appDir: "/tmp/proj/app",
    config: {
      plugins: [
        graphql({
          schema,
          context: ({ request }) => ({ auth: request.headers.get("authorization") }),
          ...options,
        }),
      ],
      ...appConfig,
    } as DenextConfig,
    mode,
    load,
  });
  const handle = getPluginRequestHandler()!;
  // As denext's own server loop: the socket peer recorded, the app's proxy trust / limit policy.
  const inContext = (req: Request, peer: string) => {
    setRemoteAddr(req, { transport: "tcp", hostname: peer, port: 1 });
    return runWithContext(createRequestContext(req, undefined, trust), () => handle(req));
  };
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    async (req, info) =>
      (await inContext(req, info.remoteAddr.hostname)) ??
        new Response("not found", { status: 404 }),
  );
  const origin = `http://127.0.0.1:${server.addr.port}`;
  return {
    origin,
    url: `ws://127.0.0.1:${server.addr.port}/graphql`,
    handle,
    inContext,
    close: async () => {
      await server.shutdown();
      resetPlugins();
    },
  };
}

/** A `graphql-ws` client whose socket sends `headers` (a browser sends Origin + cookies itself). */
function client(
  url: string,
  headers: Record<string, string>,
  connectionParams?: Record<string, unknown>,
) {
  class HeaderSocket extends WebSocket {
    constructor(u: string | URL, protocols?: string | string[]) {
      const list = typeof protocols === "string" ? [protocols] : protocols ?? [];
      super(u, { protocols: list, headers } as unknown as string[]);
    }
  }
  return createClient({ url, webSocketImpl: HeaderSocket, retryAttempts: 0, connectionParams });
}

/** A raw socket on the endpoint, its incoming messages, and its close event. */
async function rawSocket(url: string, origin: string) {
  const ws = new WebSocket(url, {
    protocols: ["graphql-transport-ws"],
    headers: { origin },
  } as unknown as string[]);
  const messages: { type: string; id?: string; payload?: unknown }[] = [];
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
  ws.onmessage = (ev) => messages.push(JSON.parse(ev.data));
  await new Promise((r) => ws.addEventListener("open", r));
  return { ws, messages, closed, send: (m: object) => ws.send(JSON.stringify(m)) };
}

const post = (origin: string, query: string, headers: Record<string, string> = {}) =>
  new Request(`${origin}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify({ query }),
  });

Deno.test("fromChannel: a channel whose authorize refuses the request is refused (no bypass)", async () => {
  setChannelTransport(inMemoryChannelTransport());
  const closed = createChannel<number>({ id: "gqls:closed", authorize: () => false });
  const err = await assertRejects(() => fromChannel(closed, "k"));
  assertEquals((err as { extensions?: { code?: string } }).extensions?.code, "FORBIDDEN");
  await assertRejects(() => fromChannel("gqls:no-such-channel", "k"));
});

Deno.test("fromChannel: an active subscription ends when the lazy re-check fails; a held payload is not delivered", async () => {
  setChannelTransport(inMemoryChannelTransport());
  allowRooms = true;
  const it = await fromChannel(rooms, "ttl");
  await tick(5);
  await rooms.publish("ttl", { text: "still allowed" });
  assertEquals(await it.next(), { value: { text: "still allowed" }, done: false });
  allowRooms = false;
  await tick(5);
  await rooms.publish("ttl", { text: "after the deny" });
  assertEquals(await it.next(), { value: undefined, done: true });
  allowRooms = true;
});

Deno.test("graphql SSE: a key built from a client argument is checked by the channel's authorize", async () => {
  const srv = await serve();
  try {
    const sse = { accept: "text/event-stream", cookie: "uid=alice" };
    const denied = await fetch(
      post(srv.origin, 'subscription { inbox(user: "bob") { text } }', sse),
    );
    const body = await denied.text();
    assertStringIncludes(body, "FORBIDDEN");
    assertStringIncludes(body, "Not authorized to subscribe to this channel");

    attached = Promise.withResolvers();
    const ok = await fetch(post(srv.origin, 'subscription { inbox(user: "alice") { text } }', sse));
    const reader = ok.body!.getReader();
    const read = reader.read(); // pull: Yoga starts executing when the body is read
    await attached.promise;
    await inbox.publish("user:alice", { text: "for alice" });
    let text = new TextDecoder().decode((await read).value);
    while (!text.includes("for alice")) {
      text += new TextDecoder().decode((await reader.read()).value);
    }
    await reader.cancel();
  } finally {
    await srv.close();
  }
});

Deno.test("graphql-ws: a subscription over WebSocket rides the channel; complete stops it", async () => {
  const srv = await serve();
  const c = client(srv.url, { origin: srv.origin, cookie: "uid=alice" });
  try {
    attached = Promise.withResolvers();
    const it = c.iterate<{ room: Msg }>({ query: 'subscription { room(name: "lobby") { text } }' });
    const first = it.next();
    await attached.promise;
    await rooms.publish("lobby", { text: "hi" });
    assertEquals((await first).value, { data: { room: { text: "hi" } } });
    await it.return!();
    // A query and a mutation-free round trip on the same socket.
    assertEquals(
      (await c.iterate<{ hello: string }>({ query: "{ hello }" }).next()).value,
      { data: { hello: "world" } },
    );
  } finally {
    await c.dispose();
    await srv.close();
  }
});

Deno.test("graphql-ws: the channel's authorize sees the upgrade's cookie and one peer per socket; revokes end it", async () => {
  const srv = await serve();
  const c = client(srv.url, { origin: srv.origin, cookie: "uid=alice" });
  try {
    const bob = c.iterate({ query: 'subscription { inbox(user: "bob") { text } }' });
    const refused = await bob.next();
    const errors = (refused.value as { errors?: { extensions?: { code?: string } }[] }).errors;
    assertEquals(errors?.[0]?.extensions?.code, "FORBIDDEN");

    attached = Promise.withResolvers();
    const a = c.iterate({ query: 'subscription { room(name: "a") { text } }' });
    const aNext = a.next();
    await attached.promise;
    attached = Promise.withResolvers();
    const b = c.iterate({ query: 'subscription { room(name: "b") { text } }' });
    const bNext = b.next();
    await attached.promise;
    assertEquals(peers.length, 2);
    assertEquals(peers[0], peers[1], "every operation of one socket is the same peer");
    rooms.revoke("a", { peerId: peers[0] }); // this connection's peer
    assertEquals((await aNext).done, true);
    rooms.revoke("b"); // key-wide
    assertEquals((await bNext).done, true);
  } finally {
    await c.dispose();
    await srv.close();
  }
});

Deno.test("graphql-ws: the handshake needs the app's own Origin (or an allowed one); the subprotocol is required", async () => {
  const srv = await serve({ allowedOrigins: ["https://partner.example"] });
  try {
    const upgrade = (headers: Record<string, string>) =>
      srv.handle(
        new Request("http://127.0.0.1/graphql", {
          headers: {
            host: "127.0.0.1",
            upgrade: "websocket",
            connection: "upgrade",
            "sec-websocket-protocol": "graphql-transport-ws",
            ...headers,
          },
        }),
      );
    assertEquals((await upgrade({ origin: "https://evil.example" }))!.status, 403);
    assertEquals((await upgrade({}))!.status, 403, "no Origin, no socket (as Live in production)");
    // An allowed origin passes the gate (the synthetic request then can't really upgrade).
    assertEquals((await upgrade({ origin: "https://partner.example" }))!.status, 400);
    const wrongProtocol = await upgrade({
      origin: "http://127.0.0.1",
      "sec-websocket-protocol": "graphql-ws",
    });
    assertEquals(wrongProtocol!.status, 400);
    assertStringIncludes(await wrongProtocol!.text(), "graphql-transport-ws");

    // A real cross-origin socket never opens.
    const evil = client(srv.url, { origin: "https://evil.example" });
    await assertRejects(() => evil.iterate({ query: "{ hello }" }).next());
    await evil.dispose();
  } finally {
    await srv.close();
  }
});

Deno.test("graphql-ws: connection_init timeout, subscribe before ack, a second init and a duplicate id close the socket", async () => {
  const srv = await serve({ websocket: { connectionInitTimeoutMs: 50 } });
  try {
    const idle = await rawSocket(srv.url, srv.origin);
    assertEquals((await idle.closed).code, 4408);

    const early = await rawSocket(srv.url, srv.origin);
    early.send({ type: "subscribe", id: "1", payload: { query: "{ hello }" } });
    assertEquals((await early.closed).code, 4401);

    const twice = await rawSocket(srv.url, srv.origin);
    twice.send({ type: "connection_init" });
    twice.send({ type: "connection_init" });
    assertEquals((await twice.closed).code, 4429);
    assertEquals(twice.messages[0], { type: "connection_ack" });

    const dup = await rawSocket(srv.url, srv.origin);
    dup.send({ type: "connection_init" });
    dup.send({
      type: "subscribe",
      id: "s",
      payload: { query: 'subscription { room(name: "d") { text } }' },
    });
    dup.send({ type: "subscribe", id: "s", payload: { query: "{ hello }" } });
    assertEquals((await dup.closed).code, 4409);

    const junk = await rawSocket(srv.url, srv.origin);
    junk.send({ nope: true });
    assertEquals((await junk.closed).code, 4400);

    const ping = await rawSocket(srv.url, srv.origin);
    ping.send({ type: "connection_init" });
    ping.send({ type: "ping" });
    while (ping.messages.length < 2) await tick(5);
    assertEquals(ping.messages, [{ type: "connection_ack" }, { type: "pong" }]);
    ping.ws.close();
    await ping.closed;
  } finally {
    await srv.close();
  }
});

Deno.test("graphql-ws: a connection_init token is the socket's Authorization unless the upgrade carried one", async () => {
  const srv = await serve();
  try {
    const viaToken = client(srv.url, { origin: srv.origin }, { token: "t1" });
    assertEquals((await viaToken.iterate({ query: "{ auth }" }).next()).value, {
      data: { auth: "Bearer t1" },
    });
    await viaToken.dispose();
    const viaHeader = client(
      srv.url,
      { origin: srv.origin, authorization: "Bearer hdr" },
      { authorization: "Bearer payload" },
    );
    assertEquals((await viaHeader.iterate({ query: "{ auth }" }).next()).value, {
      data: { auth: "Bearer hdr" },
    });
    await viaHeader.dispose();
  } finally {
    await srv.close();
  }
});

Deno.test("graphql-ws: the per-connection operation cap, the cost budget and the depth limit apply", async () => {
  const srv = await serve({ websocket: { maxSubscriptions: 1 }, maxCost: 3, maxDepth: 2 });
  const c = client(srv.url, { origin: srv.origin });
  try {
    attached = Promise.withResolvers();
    const held = c.iterate({ query: 'subscription { room(name: "cap") { text } }' });
    const heldNext = held.next();
    await attached.promise;
    const over = await assertRejects(() => c.iterate({ query: "{ hello }" }).next());
    assertStringIncludes(JSON.stringify(over), "Too many operations");
    await held.return!();
    void heldNext;
    await tick(10);

    const costly = await c.iterate({ query: "{ self { self { hello } } hello hello }" }).next();
    assertStringIncludes(JSON.stringify(costly.value), "too expensive");
    const deep = await assertRejects(() =>
      c.iterate({ query: "{ self { self { self { hello } } } }" }).next()
    );
    assertStringIncludes(JSON.stringify(deep), "nested too deeply");
  } finally {
    await c.dispose();
    await srv.close();
  }
});

Deno.test("graphql dev: a schema-module edit reloads the schema; in-flight subscriptions on the old one end", async () => {
  const loads: string[] = [];
  const load = ((path: string) => {
    loads.push(path);
    return Promise.resolve({ schema: loads.length === 1 ? schema : schemaFor("reloaded") });
  }) as unknown as ModuleLoader;
  const srv = await serve({ schema: "./graphql/schema.ts" }, "dev", load);
  const c = client(srv.url, { origin: srv.origin });
  const prepare = {
    projectRoot: "/tmp/proj",
    appDir: "/tmp/proj/app",
    outDir: "/tmp/proj/.denext",
    config: {},
  };
  try {
    const hello = async () =>
      (await (await fetch(post(srv.origin, "{ hello }"))).json()).data.hello as string;
    assertEquals(await hello(), "world");
    assertEquals(loads, [join("/tmp/proj", "graphql/schema.ts")]); // the host's separator

    attached = Promise.withResolvers();
    const live = c.iterate({ query: 'subscription { room(name: "dev") { text } }' });
    const liveNext = live.next();
    await attached.promise;

    // An edit outside the schema's directory does not reload it.
    assertEquals(await runMatchingPrepareSteps(prepare, ["/tmp/proj/app/page.tsx"]), false);
    assertEquals(await hello(), "world");
    assertEquals(loads.length, 1);

    // An edit beside the schema module does: the next request runs on the new schema …
    assert(await runMatchingPrepareSteps(prepare, ["/tmp/proj/graphql/resolvers.ts"]));
    assertEquals(await hello(), "reloaded");
    assertEquals(loads.length, 2);
    // … and the subscription on the old one completed.
    assertEquals((await liveNext).done, true);
  } finally {
    await c.dispose();
    await srv.close();
  }
});

// ── Connection caps (WebSocket + streamed responses), as Live's maxConnections / PerIp ──

/** A synthetic upgrade from `peer` through the server's context: 429 when refused, else 400
 * (a synthetic request can't really upgrade — reaching the upgrade means the slot was free). */
function upgradeStatus(
  srv: Awaited<ReturnType<typeof serve>>,
  peer: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const req = new Request(`${srv.origin}/graphql`, {
    headers: {
      host: new URL(srv.origin).host,
      origin: srv.origin,
      upgrade: "websocket",
      connection: "upgrade",
      "sec-websocket-protocol": "graphql-transport-ws",
      ...headers,
    },
  });
  return Promise.resolve(srv.inContext(req, peer)).then((r) => r!.status);
}

/** Poll until `fn` answers `want` (a slot is released asynchronously, on the close event). */
async function eventually(fn: () => Promise<number>, want: number): Promise<number> {
  let got = await fn();
  for (let i = 0; i < 100 && got !== want; i++) {
    await tick(10);
    got = await fn();
  }
  return got;
}

const LOCAL = { limitPolicy: { localAddresses: true } };

Deno.test("graphql limits: the total cap refuses a WebSocket with 429 before the upgrade; a client close frees it", async () => {
  const srv = await serve({ maxConnections: 1 });
  try {
    const a = await rawSocket(srv.url, srv.origin);
    a.send({ type: "connection_init" });
    assertEquals(await upgradeStatus(srv, "203.0.113.1"), 429);
    a.ws.close();
    await a.closed;
    assertEquals(await eventually(() => upgradeStatus(srv, "203.0.113.1"), 400), 400);
  } finally {
    await srv.close();
  }
});

Deno.test("graphql limits: the per-address cap keys on clientIpForLimits (local peers only when counted)", async () => {
  // Untrusted loopback peers: no per-address cap (they would all be one proxy's address).
  const open = await serve({ maxConnectionsPerIp: 1 });
  try {
    const a = await rawSocket(open.url, open.origin);
    assertEquals(await upgradeStatus(open, "127.0.0.1"), 400);
    a.ws.close();
    await a.closed;
  } finally {
    await open.close();
  }
  // `rateLimitLocalAddresses`: the loopback peer is counted as itself; another address is not.
  const local = await serve({ maxConnectionsPerIp: 1 }, "prod", noopLoad, LOCAL);
  try {
    const a = await rawSocket(local.url, local.origin);
    assertEquals(await upgradeStatus(local, "127.0.0.1"), 429);
    assertEquals(await upgradeStatus(local, "10.0.0.9"), 400);
    a.ws.close();
    await a.closed;
    assertEquals(await eventually(() => upgradeStatus(local, "127.0.0.1"), 400), 400);
  } finally {
    await local.close();
  }
  // `rateLimitHeader` behind a trusted proxy: the header's address is the client.
  const proxied = await serve({ maxConnectionsPerIp: 1 }, "prod", noopLoad, {
    trustForwardedHeaders: true,
    limitPolicy: { header: "cf-connecting-ip" },
  });
  try {
    const ws = new WebSocket(proxied.url, {
      protocols: ["graphql-transport-ws"],
      headers: { origin: proxied.origin, "cf-connecting-ip": "198.51.100.7" },
    } as unknown as string[]);
    const closed = new Promise((r) => ws.addEventListener("close", r));
    await new Promise((r) => ws.addEventListener("open", r));
    const as = (ip: string) => upgradeStatus(proxied, "127.0.0.1", { "cf-connecting-ip": ip });
    assertEquals(await as("198.51.100.7"), 429);
    assertEquals(await as("198.51.100.8"), 400);
    ws.close();
    await closed;
  } finally {
    await proxied.close();
  }
});

Deno.test("graphql limits: the init timeout and a protocol error release the WebSocket's slot", async () => {
  const srv = await serve(
    { maxConnections: 1, websocket: { connectionInitTimeoutMs: 50 } },
    "prod",
    noopLoad,
  );
  try {
    const idle = await rawSocket(srv.url, srv.origin);
    assertEquals(await upgradeStatus(srv, "203.0.113.1"), 429);
    assertEquals((await idle.closed).code, 4408);
    assertEquals(await eventually(() => upgradeStatus(srv, "203.0.113.1"), 400), 400);

    const junk = await rawSocket(srv.url, srv.origin);
    assertEquals(await upgradeStatus(srv, "203.0.113.1"), 429);
    junk.send({ nope: true });
    assertEquals((await junk.closed).code, 4400);
    assertEquals(await eventually(() => upgradeStatus(srv, "203.0.113.1"), 400), 400);
  } finally {
    await srv.close();
  }
});

Deno.test("graphql limits: a streamed (SSE) subscription holds a slot until cancelled, completed or failed; plain queries don't", async () => {
  const srv = await serve({ maxConnections: 1 });
  const sse = (query: string) => fetch(post(srv.origin, query, { accept: "text/event-stream" }));
  const sseStatus = async () => {
    const res = await sse("{ hello }");
    await res.body?.cancel();
    return res.status;
  };
  try {
    attached = Promise.withResolvers();
    const live = await sse('subscription { room(name: "sse") { text } }');
    const reader = live.body!.getReader();
    const read = reader.read();
    await attached.promise;
    const refused = await sse('subscription { room(name: "other") { text } }');
    assertEquals(refused.status, 429);
    await refused.body?.cancel();
    // A plain JSON query takes no slot.
    assertEquals((await fetch(post(srv.origin, "{ hello }"))).status, 200);
    // Cancelled by the client → freed.
    await reader.cancel();
    void read.catch(() => {});
    assertEquals(await eventually(sseStatus, 200), 200);

    // Completed by the server (a revoke ends the subscription) → freed.
    attached = Promise.withResolvers();
    const revoked = await sse('subscription { room(name: "rv") { text } }');
    const rr = revoked.body!.getReader();
    const first = rr.read();
    await attached.promise;
    assertEquals((await sse("{ hello }")).status, 429);
    rooms.revoke("rv");
    await first;
    while (!(await rr.read()).done) { /* drain to the end */ }
    assertEquals(await eventually(sseStatus, 200), 200);

    // Failed (a refused subscription is an error result) → freed.
    const failed = await sse('subscription { inbox(user: "nobody") { text } }');
    assertStringIncludes(await failed.text(), "FORBIDDEN");
    assertEquals(await eventually(sseStatus, 200), 200);
  } finally {
    await srv.close();
  }
});

Deno.test("graphql limits: a dev schema reload ends the old streams and frees their slots", async () => {
  let loads = 0;
  const load = (() => {
    loads++;
    return Promise.resolve({ schema: loads === 1 ? schema : schemaFor("reloaded") });
  }) as unknown as ModuleLoader;
  const srv = await serve({ schema: "./graphql/schema.ts", maxConnections: 1 }, "dev", load);
  const prepare = { projectRoot: "/tmp/proj", appDir: "/tmp/proj/app", outDir: "/x", config: {} };
  try {
    attached = Promise.withResolvers();
    const live = await fetch(
      post(srv.origin, 'subscription { room(name: "reload") { text } }', {
        accept: "text/event-stream",
      }),
    );
    const reader = live.body!.getReader();
    const first = reader.read();
    await attached.promise;
    assert(await runMatchingPrepareSteps(prepare, ["/tmp/proj/graphql/schema.ts"]));
    // The next request reloads (a plain query: no slot needed) and ends the old stream.
    assertEquals(
      (await (await fetch(post(srv.origin, "{ hello }"))).json()).data.hello,
      "reloaded",
    );
    await first;
    while (!(await reader.read()).done) { /* the old stream completes */ }
    const again = async () => {
      const res = await fetch(post(srv.origin, "{ hello }", { accept: "text/event-stream" }));
      await res.body?.cancel();
      return res.status;
    };
    assertEquals(await eventually(again, 200), 200);
  } finally {
    await srv.close();
  }
});

Deno.test("graphql limits: the caps default to the app's live.limits, else Live's defaults", async () => {
  const { resolveCaps } = await import("../packages/graphql/limits.ts");
  assertEquals(resolveCaps({}, undefined), { maxConnections: 10_000, maxConnectionsPerIp: 64 });
  assertEquals(resolveCaps({}, { maxConnections: 50, maxConnectionsPerIp: 5 }), {
    maxConnections: 50,
    maxConnectionsPerIp: 5,
  });
  assertEquals(
    resolveCaps({ maxConnectionsPerIp: 2 }, { maxConnectionsPerIp: 5 }).maxConnectionsPerIp,
    2,
  );
  assertEquals(resolveCaps({ maxConnections: -1 }, undefined).maxConnections, 10_000);
  // Through the plugin: live.limits.maxConnections applies to the GraphQL socket too.
  const srv = await serve({}, "prod", noopLoad, {}, { live: { limits: { maxConnections: 1 } } });
  try {
    const a = await rawSocket(srv.url, srv.origin);
    assertEquals(await upgradeStatus(srv, "203.0.113.1"), 429);
    a.ws.close();
    await a.closed;
  } finally {
    await srv.close();
  }
});
