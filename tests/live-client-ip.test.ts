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
import {
  clientIp,
  clientIpForLimits,
  createRequestContext,
  runWithContext,
} from "../src/server/request-context.ts";
import {
  ipBucket,
  isLocalAddress,
  limitAddrOf,
  type LimitAddrPolicy,
  resetLimitHeaderWarningForTesting,
  resolveLimitPolicy,
  setRemoteAddr,
} from "../src/server/remote-addr.ts";

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
  limitPolicy?: LimitAddrPolicy,
): { server: Deno.HttpServer; port: number } {
  installLiveHub({
    appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
    originAllowed: () => true,
    config,
    trustForwardedHeaders,
    limitPolicy,
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

Deno.test("clientIpForLimits({ bucket: true }): an IPv6 address's /64, IPv4 as it is, none stays none", () => {
  const at = (ip: string) => {
    const request = new Request("http://app.test/");
    setRemoteAddr(request, { transport: "tcp", hostname: ip, port: 1 });
    return request;
  };
  const read = (request: Request, options?: { bucket?: boolean }) =>
    runWithContext(createRequestContext(request), () => clientIpForLimits(options));
  assertEquals(read(at("2001:db8:1:2::a")), "2001:db8:1:2::a", "the address by default");
  assertEquals(read(at("2001:db8:1:2::a"), { bucket: true }), "2001:db8:1:2::/64");
  assertEquals(read(at("2001:0DB8:1:2:ffff:0:0:1"), { bucket: true }), "2001:db8:1:2::/64");
  assertEquals(read(at("198.51.100.7"), { bucket: true }), "198.51.100.7");
  assertEquals(read(at("::1"), { bucket: true }), undefined, "an untrusted local peer: none");
});

// --- rateLimitHeader / rateLimitLocalAddresses (Supabase Auth's GOTRUE_RATE_LIMIT_HEADER model) ---

const CF = { header: "cf-connecting-ip" } satisfies LimitAddrPolicy;

Deno.test("resolveLimitPolicy: the header trimmed and lower-cased, an empty one none; the switch only when true", () => {
  assertEquals(resolveLimitPolicy({}), {});
  assertEquals(resolveLimitPolicy({ rateLimitHeader: " CF-Connecting-IP " }), CF);
  assertEquals(resolveLimitPolicy({ rateLimitHeader: "  ", rateLimitLocalAddresses: false }), {});
  assertEquals(resolveLimitPolicy({ rateLimitLocalAddresses: true }), { localAddresses: true });
});

Deno.test("limitAddrOf + rateLimitHeader: the header's last IP value is the limit address — local or not, over any hop", () => {
  const via = (peer: string, value: string, extra: Record<string, string> = {}) =>
    upgradeFrom(peer, { "cf-connecting-ip": value, ...extra });
  // Behind a loopback proxy (untrusted) the named header is the client — even a private client.
  assertEquals(limitAddrOf(via("127.0.0.1", "198.51.100.7"), false, CF), "198.51.100.7");
  assertEquals(limitAddrOf(via("127.0.0.1", "10.1.2.3"), false, CF), "10.1.2.3");
  // A proxy that appends: only its own (last) value counts, a client-sent first one does not.
  assertEquals(limitAddrOf(via("::1", "6.6.6.6, 203.0.113.9"), false, CF), "203.0.113.9");
  // IPv6, bracketed or not; the header outranks a trusted x-forwarded-for hop.
  const v6 = via("10.0.0.2", "[2001:db8:1:2::a]", { "x-forwarded-for": "192.0.2.1" });
  assertEquals(limitAddrOf(v6, true, CF), "2001:db8:1:2::a");
  // Header names match case-insensitively (the Headers API), and the policy name is lower-case.
  assertEquals(
    limitAddrOf(upgradeFrom("::1", { "CF-Connecting-IP": "192.0.2.8" }), false, CF),
    "192.0.2.8",
  );
});

Deno.test("limitAddrOf + rateLimitHeader: a request without an IP in it falls back to the peer / hop rule — warned once", async () => {
  resetLimitHeaderWarningForTesting();
  const warnings = await capturingWarnings(() => {
    // Missing: a public peer (a client that bypassed the proxy) is limited by its own address…
    assertEquals(limitAddrOf(upgradeFrom("198.51.100.7"), false, CF), "198.51.100.7");
    // …a trusted hop is used as without the option…
    const hop = upgradeFrom("10.0.0.2", { "x-forwarded-for": "192.0.2.1" });
    assertEquals(limitAddrOf(hop, true, CF), "192.0.2.1");
    // …and a local peer is still skipped (never a site-wide bucket) unless local limits are on.
    assertEquals(limitAddrOf(upgradeFrom("127.0.0.1"), false, CF), undefined);
    const both = { ...CF, localAddresses: true };
    assertEquals(limitAddrOf(upgradeFrom("127.0.0.1"), false, both), "127.0.0.1");
    // Not an IP address (empty, a hostname, a port suffix, junk): the same fallback.
    for (const junk of [" , ", "unknown", "198.51.100.7:443", "999.1.1.1", "2001:db8::g"]) {
      const request = upgradeFrom("198.51.100.9", { "cf-connecting-ip": junk });
      assertEquals(limitAddrOf(request, false, CF), "198.51.100.9", junk);
    }
    return Promise.resolve();
  });
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assert(warnings[0].includes("cf-connecting-ip") && warnings[0].includes("rateLimitHeader"));
  resetLimitHeaderWarningForTesting();
});

Deno.test("limitAddrOf + rateLimitLocalAddresses: a loopback/private peer counts as itself; a trusted hop still wins", () => {
  const local = { localAddresses: true };
  for (
    const peer of ["127.0.0.1", "10.0.0.2", "192.168.1.1", "::1", "fd12::1", "::ffff:10.0.0.2"]
  ) {
    assertEquals(limitAddrOf(upgradeFrom(peer), false, local), peer, peer);
  }
  assertEquals(limitAddrOf(upgradeFrom("198.51.100.7"), false, local), "198.51.100.7");
  const hop = upgradeFrom("10.0.0.2", { "x-forwarded-for": "192.0.2.1" });
  assertEquals(limitAddrOf(hop, true, local), "192.0.2.1");
  assertEquals(limitAddrOf(hop, false, local), "10.0.0.2", "an untrusted header is still ignored");
});

Deno.test("clientIpForLimits + rateLimitHeader: IPv6 bucketed by /64 and IPv4-mapped as its IPv4; clientIp() unchanged", () => {
  const read = (value: string, options?: { bucket?: boolean }) => {
    const request = upgradeFrom("127.0.0.1", { "cf-connecting-ip": value });
    const ctx = createRequestContext(request, undefined, { limitPolicy: CF });
    return runWithContext(ctx, () => [clientIp(), clientIpForLimits(options)]);
  };
  assertEquals(read("2001:db8:1:2::a", { bucket: true }), ["127.0.0.1", "2001:db8:1:2::/64"]);
  assertEquals(read("2001:0DB8:1:2:ffff::1", { bucket: true })[1], "2001:db8:1:2::/64");
  assertEquals(read("::ffff:198.51.100.7", { bucket: true })[1], "198.51.100.7");
  assertEquals(read("::ffff:c633:6407", { bucket: true })[1], "198.51.100.7");
  assertEquals(read("198.51.100.7"), ["127.0.0.1", "198.51.100.7"], "clientIp() keeps the peer");
  // The local-addresses switch, through the context.
  const peer = upgradeFrom("10.0.0.2");
  const ctx = createRequestContext(peer, undefined, { limitPolicy: { localAddresses: true } });
  assertEquals(runWithContext(ctx, () => clientIpForLimits()), "10.0.0.2");
});

Deno.test("live maxConnectionsPerIp + rateLimitHeader: behind a loopback proxy each named client is capped on its own", async () => {
  const { server, port } = startHub({ limits: { maxConnectionsPerIp: 1 } }, false, undefined, CF);
  resetLiveWarningsForTesting();
  const a = { "cf-connecting-ip": "198.51.100.7" };
  try {
    const ws = await open(port, a);
    await capturingWarnings(async () => {
      assertEquals((await handleLiveUpgrade(upgradeFrom("127.0.0.1", a))).status, 429);
      // Another client (an IPv6 one, keyed by its /64) gets in.
      const b = { "cf-connecting-ip": "2001:db8:1:2::a" };
      assertEquals((await handleLiveUpgrade(upgradeFrom("127.0.0.1", b))).status, 400);
    });
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("live maxConnectionsPerIp + rateLimitLocalAddresses: the loopback peer itself is capped, with no proxy warning", async () => {
  const local = { localAddresses: true };
  const { server, port } = startHub(
    { limits: { maxConnectionsPerIp: 1 } },
    false,
    undefined,
    local,
  );
  resetLiveWarningsForTesting();
  try {
    const ws = await open(port);
    const warnings = await capturingWarnings(async () => {
      assertEquals((await handleLiveUpgrade(upgradeFrom("127.0.0.1"))).status, 429);
      assertEquals((await handleLiveUpgrade(upgradeFrom("10.0.0.2"))).status, 400, "another peer");
    });
    assertEquals(warnings.filter((w) => w.includes("loopback/private")), []);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("ipBucket: NAT64 (64:ff9b::/96) and IPv4-compatible addresses bucket by their embedded IPv4", () => {
  assertEquals(ipBucket("64:ff9b::198.51.100.7"), "198.51.100.7");
  assertEquals(ipBucket("64:ff9b::c633:6407"), "198.51.100.7");
  assertEquals(ipBucket("64:FF9B:0:0:0:0:c633:6408"), "198.51.100.8", "another NAT64 client");
  assertEquals(ipBucket("::198.51.100.7"), "198.51.100.7");
  assertEquals(ipBucket("::ffff:198.51.100.7"), "198.51.100.7");
  // Not embedded IPv4: the unspecified and loopback addresses, a NAT64 local-use /48, plain v6.
  assertEquals(ipBucket("::1"), "0:0:0:0::/64");
  assertEquals(ipBucket("::"), "0:0:0:0::/64");
  assertEquals(ipBucket("64:ff9b:1::c633:6407"), "64:ff9b:1:0::/64");
  assertEquals(ipBucket("2001:db8::c633:6407"), "2001:db8:0:0::/64");
});

Deno.test("limitAddrOf + rateLimitHeader: no warning for an in-process request with no recorded peer", async () => {
  resetLimitHeaderWarningForTesting();
  const warnings = await capturingWarnings(() => {
    assertEquals(limitAddrOf(new Request("http://app.test/"), false, CF), undefined);
    return Promise.resolve();
  });
  assertEquals(warnings, []);
  resetLimitHeaderWarningForTesting();
});
