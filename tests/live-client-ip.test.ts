// The Live hub carries the upgrade request's client address into every connection-scoped
// context — channel `authorize`, a subscription's resolver, the connection `authorize` hook — so
// `clientIp()` answers there what it answered in the upgrade request (the socket peer, or the
// trusted proxy's last `x-forwarded-for` hop). And `live.limits.maxConnectionsPerIp` caps the
// connections one address (an IPv6 /64) may hold — unless that address is an untrusted
// loopback/private socket peer (a reverse proxy every visitor shares), where the cap is off and
// `clientIpForLimits()` answers `undefined`.

import { assert, assertEquals } from "@std/assert";
import {
  handleLiveUpgrade,
  installLiveHub,
  resetLiveWarningsForTesting,
  uninstallLiveHub,
} from "../src/server/live.ts";
import type { LiveConfig } from "../src/server/config.ts";
import { createChannel, resetChannels } from "../src/runtime/channel.ts";
import { defineSubscription } from "../src/runtime/define-subscription.ts";
import type { StandardSchemaV1 } from "../src/runtime/define-action.ts";
import { clientIp, clientIpForLimits } from "../src/server/request-context.ts";
import { isLocalAddress, limitAddrOf, setRemoteAddr } from "../src/server/remote-addr.ts";

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
function upgradeFrom(addr: string, headers: Record<string, string> = {}): Request {
  const req = new Request("http://app.test/_denext/live", {
    headers: { upgrade: "websocket", ...headers },
  });
  setRemoteAddr(req, { transport: "tcp", hostname: addr, port: 1 });
  return req;
}

/** Open a socket (with extra handshake headers) and resolve once it is open. */
function open(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_denext/live`, { headers } as Any);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("socket error"));
  });
}

/** Run `fn` with `console.warn` captured; resolves with what it logged. */
async function capturingWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

Deno.test("live maxConnectionsPerIp: one address's connections are capped; others, and a freed slot, get in", async () => {
  // The server records every connection as 198.51.100.7 (a directly connected public client).
  const { server, port } = startHub({ limits: { maxConnectionsPerIp: 2 } }, false, "198.51.100.7");
  resetLiveWarningsForTesting();
  try {
    const sockets = [await open(port), await open(port)];
    // A third from the address is refused before upgrading — with one warning naming the address
    // and the option, however many refusals follow; another address is not refused.
    const warnings = await capturingWarnings(async () => {
      assertEquals((await handleLiveUpgrade(upgradeFrom("198.51.100.7"))).status, 429);
      assertEquals((await handleLiveUpgrade(upgradeFrom("198.51.100.7"))).status, 429);
    });
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assert(warnings[0].includes("198.51.100.7") && warnings[0].includes("maxConnectionsPerIp"));
    assertEquals((await handleLiveUpgrade(upgradeFrom("192.0.2.4"))).status, 400, "not capped");
    // Closing one frees its slot (once the server has seen the close).
    const closed = sockets.pop()!;
    closed.close();
    const deadline = Date.now() + WS_TIMEOUT_MS;
    let status = 429;
    await capturingWarnings(async () => {
      while (status === 429 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = (await handleLiveUpgrade(upgradeFrom("198.51.100.7"))).status;
      }
    });
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

Deno.test("live maxConnectionsPerIp: an untrusted loopback/private peer is not capped per address — the total still applies — and warns once", async () => {
  // Behind a reverse proxy without trustForwardedHeaders every visitor arrives from the proxy's
  // address (here the real socket peer, 127.0.0.1): one per-address cap would be site-wide.
  const { server, port } = startHub({ limits: { maxConnectionsPerIp: 1, maxConnections: 3 } });
  resetLiveWarningsForTesting();
  const sockets: WebSocket[] = [];
  try {
    const warnings = await capturingWarnings(async () => {
      sockets.push(await open(port), await open(port));
      for (const proxy of ["10.0.0.2", "172.20.1.1", "192.168.1.1", "169.254.0.1", "::1"]) {
        assertEquals((await handleLiveUpgrade(upgradeFrom(proxy))).status, 400, proxy);
      }
      for (const proxy of ["fd12::1", "fe80::1", "::ffff:10.0.0.2", "::ffff:127.0.0.1"]) {
        assertEquals((await handleLiveUpgrade(upgradeFrom(proxy))).status, 400, proxy);
      }
      sockets.push(await open(port));
      // The total cap still counts them.
      assertEquals((await handleLiveUpgrade(upgradeFrom("10.0.0.2"))).status, 503);
    });
    assertEquals(warnings.length, 1, warnings.join("\n"));
    assert(warnings[0].includes("127.0.0.1"), warnings[0]);
    assert(warnings[0].includes("trustForwardedHeaders"), warnings[0]);
    assert(warnings[0].includes("DENEXT_TRUST_PROXY=1"), warnings[0]);
  } finally {
    for (const ws of sockets) ws.close();
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("live maxConnectionsPerIp: a trusted proxy's hop is capped even when private; without a hop its peer is not", async () => {
  const { server, port } = startHub({ limits: { maxConnectionsPerIp: 1 } }, true);
  resetLiveWarningsForTesting();
  const hop = { "x-forwarded-for": "198.51.100.1, 10.9.8.7" };
  try {
    const ws = await open(port, hop);
    await capturingWarnings(async () => {
      assertEquals((await handleLiveUpgrade(upgradeFrom("127.0.0.1", hop))).status, 429);
      // No forwarded hop: the address is the (loopback) socket peer — not capped.
      assertEquals((await handleLiveUpgrade(upgradeFrom("127.0.0.1"))).status, 400);
    });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("live clientIpForLimits: a hook sees the address to limit on — none for a proxy-looking peer", async () => {
  resetChannels();
  const seen: [string | undefined, string | undefined][] = [];
  createChannel<number>({
    id: "ip#limits",
    authorize: () => {
      seen.push([clientIp(), clientIpForLimits()]);
      return true;
    },
  });
  const sub = { type: "channel-subscribe", subId: "s1", channelId: "ip#limits", key: "k" };
  const cases: [string | undefined, boolean, Record<string, string> | undefined][] = [
    ["198.51.100.7", false, undefined], // a public peer
    [undefined, false, undefined], // the real 127.0.0.1 peer, untrusted
    [undefined, true, { "x-forwarded-for": "10.9.8.7" }], // a trusted proxy's private hop
  ];
  try {
    for (const [peer, trusted, headers] of cases) {
      const { server, port } = startHub({}, trusted, peer);
      resetLiveWarningsForTesting();
      try {
        await capturingWarnings(async () => {
          assertEquals((await exchange(port, sub, headers)).type, "channel-ready");
        });
      } finally {
        uninstallLiveHub();
        await server.shutdown();
      }
    }
    assertEquals(seen, [
      ["198.51.100.7", "198.51.100.7"],
      ["127.0.0.1", undefined],
      ["10.9.8.7", "10.9.8.7"],
    ]);
  } finally {
    resetChannels();
  }
});

Deno.test("isLocalAddress / limitAddrOf: loopback, private, link-local and ULA peers (and their mapped forms) are local", () => {
  const local = [
    "127.0.0.1",
    "127.255.0.9",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.1.1",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "fe80::1%en0",
    "febf::1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
  ];
  const remote = [
    "198.51.100.7",
    "172.15.0.1",
    "172.32.0.1",
    "169.253.0.1",
    "11.0.0.1",
    "2001:db8::1",
    "fec0::1",
    "::ffff:198.51.100.7",
  ];
  for (const addr of local) assert(isLocalAddress(addr), addr);
  for (const addr of remote) assert(!isLocalAddress(addr), addr);
  for (const addr of [...local, ...remote]) {
    const expected = local.includes(addr) ? undefined : addr;
    assertEquals(limitAddrOf(upgradeFrom(addr), false), expected, addr);
    assertEquals(limitAddrOf(upgradeFrom(addr), true), expected, `${addr}, no hop`);
  }
  const forwarded = upgradeFrom("127.0.0.1", { "x-forwarded-for": "10.0.0.1" });
  assertEquals(limitAddrOf(forwarded, true), "10.0.0.1", "a trusted hop, even private");
  assertEquals(limitAddrOf(forwarded, false), undefined, "an untrusted header is ignored");
});
