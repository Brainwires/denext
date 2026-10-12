// The Live hub carries the upgrade request's client address into every connection-scoped
// context — channel `authorize`, a subscription's resolver, the connection `authorize` hook — so
// `clientIp()` answers there what it answered in the upgrade request (the socket peer, or the
// trusted proxy's last `x-forwarded-for` hop). And `live.limits.maxConnectionsPerIp` caps the
// connections one address (an IPv6 /64) may hold.

import { assertEquals } from "@std/assert";
import { handleLiveUpgrade, installLiveHub, uninstallLiveHub } from "../src/server/live.ts";
import type { LiveConfig } from "../src/server/config.ts";
import { createChannel, resetChannels } from "../src/runtime/channel.ts";
import { defineSubscription } from "../src/runtime/define-subscription.ts";
import type { StandardSchemaV1 } from "../src/runtime/define-action.ts";
import { clientIp } from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const WS_TIMEOUT_MS = Number(Deno.env.get("DENEXT_TEST_WS_TIMEOUT_MS")) || 15_000;

/**
 * A hub behind a real server whose loop records the socket peer, as `denext start` does (or
 * `peer`, standing in for a client at another address).
 */
function startHub(
  config: LiveConfig,
  trustForwardedHeaders = false,
  peer?: string,
): { server: Deno.HttpServer; port: number } {
  installLiveHub({
    appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
    originAllowed: () => true,
    config,
    trustForwardedHeaders,
  });
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req, info) => {
    setRemoteAddr(req, peer ? { transport: "tcp", hostname: peer, port: 1 } : info.remoteAddr);
    return handleLiveUpgrade(req);
  });
  return { server, port: (server.addr as Deno.NetAddr).port };
}

/** Open a socket (with extra handshake headers), send `frame`, resolve with the first reply. */
function exchange(port: number, frame: unknown, headers?: Record<string, string>): Promise<Any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_denext/live`, { headers } as Any);
    const timer = setTimeout(() => reject(new Error("no reply")), WS_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify(frame));
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(ev.data as string));
    };
    ws.onerror = () => reject(new Error("socket error"));
  });
}

Deno.test("live clientIp: a channel's authorize sees the connection's socket peer", async () => {
  resetChannels();
  const seen: (string | undefined)[] = [];
  createChannel<number>({
    id: "ip#peer",
    authorize: () => {
      seen.push(clientIp());
      return true;
    },
  });
  const { server, port } = startHub({});
  try {
    const reply = await exchange(port, {
      type: "channel-subscribe",
      subId: "s1",
      channelId: "ip#peer",
      key: "k",
    });
    assertEquals(reply.type, "channel-ready");
    assertEquals(seen, ["127.0.0.1"]);
  } finally {
    uninstallLiveHub();
    resetChannels();
    await server.shutdown();
  }
});

Deno.test("live clientIp: behind a trusted proxy, hooks see its last x-forwarded-for hop — and only then", async () => {
  resetChannels();
  const seen: (string | undefined)[] = [];
  createChannel<number>({
    id: "ip#proxy",
    authorize: () => {
      seen.push(clientIp());
      return true;
    },
  });
  const sub = { type: "channel-subscribe", subId: "s1", channelId: "ip#proxy", key: "k" };
  const forwarded = { "x-forwarded-for": "198.51.100.1, 203.0.113.9" };
  for (const trusted of [true, false]) {
    const connectionHook: (string | undefined)[] = [];
    const { server, port } = startHub({
      authorize: () => {
        connectionHook.push(clientIp());
        return true;
      },
    }, trusted);
    try {
      assertEquals((await exchange(port, sub, forwarded)).type, "channel-ready");
      const expected = trusted ? "203.0.113.9" : "127.0.0.1";
      assertEquals(connectionHook, [expected], "the connection authorize hook");
    } finally {
      uninstallLiveHub();
      await server.shutdown();
    }
  }
  assertEquals(seen, ["203.0.113.9", "127.0.0.1"]);
  resetChannels();
});

Deno.test("live clientIp: a subscription's resolver runs with the connection's address", async () => {
  const seen: (string | undefined)[] = [];
  const anyInput: StandardSchemaV1<unknown> = {
    "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
  };
  defineSubscription<number, unknown>({
    id: "ip#sub",
    input: anyInput,
    tags: () => ["ip-tag"],
    resolve: () => {
      seen.push(clientIp());
      return 1;
    },
  });
  const { server, port } = startHub({});
  try {
    const reply = await exchange(port, {
      type: "data-subscribe",
      subId: "d1",
      actionId: "ip#sub",
      args: [{}],
      tags: [],
    });
    assertEquals(reply, { type: "data", subId: "d1", value: 1 });
    assertEquals(seen, ["127.0.0.1"]);
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

/** An upgrade request from `addr` (not through a server: the upgrade itself then fails, 400). */
function upgradeFrom(addr: string): Request {
  const req = new Request("http://app.test/_denext/live", { headers: { upgrade: "websocket" } });
  setRemoteAddr(req, { transport: "tcp", hostname: addr, port: 1 });
  return req;
}

/** Open a socket and resolve once it is open. */
function open(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_denext/live`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("socket error"));
  });
}

Deno.test("live maxConnectionsPerIp: one address's connections are capped; others, and a freed slot, get in", async () => {
  const { server, port } = startHub({ limits: { maxConnectionsPerIp: 2 } });
  try {
    const sockets = [await open(port), await open(port)];
    // A third from 127.0.0.1 is refused before upgrading; another address is not.
    assertEquals((await handleLiveUpgrade(upgradeFrom("127.0.0.1"))).status, 429);
    assertEquals((await handleLiveUpgrade(upgradeFrom("192.0.2.4"))).status, 400, "not capped");
    // Closing one frees its slot (once the server has seen the close).
    const closed = sockets.pop()!;
    closed.close();
    const deadline = Date.now() + WS_TIMEOUT_MS;
    let status = 429;
    while (status === 429 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await handleLiveUpgrade(upgradeFrom("127.0.0.1"))).status;
    }
    assertEquals(status, 400, "the freed slot admits the address again");
    for (const ws of sockets) ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("live maxConnectionsPerIp: an IPv6 /64 counts as one address", async () => {
  // The server records every connection as 2001:db8::1 (a client on a v6 network).
  const { server, port } = startHub({ limits: { maxConnectionsPerIp: 1 } }, false, "2001:db8::1");
  try {
    const ws = await open(port);
    // Another address in the same /64 (another spelling, or another host part) is the same client…
    assertEquals((await handleLiveUpgrade(upgradeFrom("2001:db8:0:0::ffff"))).status, 429);
    assertEquals((await handleLiveUpgrade(upgradeFrom("[2001:DB8::1]"))).status, 429);
    // …the next /64 is not.
    assertEquals((await handleLiveUpgrade(upgradeFrom("2001:db8:0:1::1"))).status, 400);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});
