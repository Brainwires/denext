// Supervised Live work over real WebSockets: a `defineSubscription({ restart })` resolver that
// throws is restarted with backoff — no `failed` frame while a restart is pending, and the socket
// stays open — until it gives up; a `createChannel({ publisher })` producer that throws is
// restarted the same way, and is stopped when its key goes idle. Without `restart` the old
// behaviour holds (a `failed` frame, the subscription kept for its next invalidation).

import { assert, assertEquals } from "@std/assert";
import { handleLiveUpgrade, installLiveHub, uninstallLiveHub } from "../src/server/live.ts";
import { defineSubscription } from "../src/runtime/define-subscription.ts";
import { createChannel, resetChannels } from "../src/runtime/channel.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Fast, exact restarts so a test waits milliseconds, not seconds. */
const FAST = { maxRestarts: 3, backoff: { initialMs: 5, maxMs: 20, jitter: 0 } };

const WS_TIMEOUT_MS = Number(Deno.env.get("DENEXT_TEST_WS_TIMEOUT_MS")) || 15_000;

function startHub(): { server: Deno.HttpServer; port: number } {
  installLiveHub({
    appHandler: () => Promise.resolve(new Response(null, { status: 404 })),
    originAllowed: () => true,
    config: {},
  });
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/_denext/live") return handleLiveUpgrade(req);
    return new Response("not found", { status: 404 });
  });
  return { server, port: (server.addr as Deno.NetAddr).port };
}

/**
 * Open a socket, send `first` on open, and resolve once `done(frames)` holds for the frames
 * received so far (every frame, any type). Records whether the socket closed meanwhile.
 */
function watch(
  port: number,
  first: Record<string, unknown>,
  done: (frames: Any[]) => boolean,
): Promise<{ ws: WebSocket; frames: Any[]; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/_denext/live`);
    const frames: Any[] = [];
    let closed = false;
    const timer = setTimeout(
      () => reject(new Error(`timeout; frames: ${JSON.stringify(frames)}`)),
      WS_TIMEOUT_MS,
    );
    ws.onopen = () => ws.send(JSON.stringify(first));
    ws.onclose = () => closed = true;
    ws.onerror = () => reject(new Error("socket error"));
    ws.onmessage = (ev) => {
      frames.push(JSON.parse(ev.data as string));
      if (done(frames)) {
        clearTimeout(timer);
        resolve({ ws, frames, closed: () => closed });
      }
    };
  });
}

/** Silence the supervision log and the redacted-error log for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { error, warn } = console;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

Deno.test("Live restart: a throwing resolver is restarted with backoff — no failed frame, the socket stays open", async () => {
  let calls = 0;
  defineSubscription<number, { id: string }>({
    id: "sup#flaky",
    restart: FAST,
    resolve: () => {
      calls++;
      if (calls < 3) throw new Error("db blip");
      return 42;
    },
  });
  const { server, port } = startHub();
  try {
    const { ws, frames, closed } = await quietly(() =>
      watch(
        port,
        {
          type: "data-subscribe",
          subId: "s",
          actionId: "sup#flaky",
          args: [{ id: "1" }],
          tags: [],
        },
        (f) => f.some((m) => m.type === "data"),
      )
    );
    assertEquals(calls, 3, "two crashes, then the value");
    assertEquals(frames.filter((m) => m.type === "error"), [], "no failed frame while restarting");
    assertEquals(frames.at(-1), { type: "data", subId: "s", value: 42 });
    assert(!closed(), "the socket was never dropped");
    assertEquals(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("Live restart: past maxRestarts it gives up with the usual failed frame, and the socket stays", async () => {
  let calls = 0;
  defineSubscription<number, { id: string }>({
    id: "sup#down",
    restart: { ...FAST, maxRestarts: 2 },
    resolve: () => {
      calls++;
      throw new Error("down for good");
    },
  });
  const { server, port } = startHub();
  try {
    const { ws, frames, closed } = await quietly(() =>
      watch(
        port,
        { type: "data-subscribe", subId: "d", actionId: "sup#down", args: [{ id: "1" }], tags: [] },
        (f) => f.some((m) => m.type === "error"),
      )
    );
    assertEquals(calls, 3, "the first run and two restarts");
    const failed = frames.find((m) => m.type === "error");
    assertEquals([failed.code, failed.subId], ["failed", "d"]);
    assert(!closed());
    assertEquals(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("Live restart: without `restart` a throwing resolver keeps today's behaviour (one failed frame, no rerun)", async () => {
  let calls = 0;
  defineSubscription<number, { id: string }>({
    id: "sup#plain",
    resolve: () => {
      calls++;
      throw new Error("boom");
    },
  });
  const { server, port } = startHub();
  try {
    const { ws } = await quietly(() =>
      watch(
        port,
        {
          type: "data-subscribe",
          subId: "p",
          actionId: "sup#plain",
          args: [{ id: "1" }],
          tags: [],
        },
        (f) => f.some((m) => m.type === "error"),
      )
    );
    assertEquals(calls, 1);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("Live restart: a closed socket cancels the pending restart", async () => {
  let calls = 0;
  let firstCall!: () => void;
  const called = new Promise<void>((r) => firstCall = r);
  defineSubscription<number, { id: string }>({
    id: "sup#gone",
    restart: { maxRestarts: 5, backoff: { initialMs: 200, jitter: 0 } },
    resolve: () => {
      calls++;
      firstCall();
      throw new Error("x");
    },
  });
  const { server, port } = startHub();
  try {
    await quietly(async () => {
      const ws = new WebSocket(`ws://localhost:${port}/_denext/live`);
      ws.onopen = () =>
        ws.send(JSON.stringify({
          type: "data-subscribe",
          subId: "g",
          actionId: "sup#gone",
          args: [{ id: "1" }],
          tags: [],
        }));
      await called;
      const closed = new Promise((r) => ws.onclose = r);
      ws.close();
      await closed;
      // The restart was due 200 ms after the crash; a closed socket dropped it, and the test's
      // op sanitizer would flag a timer left armed.
      await new Promise((r) => setTimeout(r, 300));
    });
    assertEquals(calls, 1);
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

Deno.test("channel publisher: a throwing producer restarts with backoff and publishes; idle stops it", async () => {
  resetChannels();
  const signals: AbortSignal[] = [];
  let stopped!: () => void;
  const stoppedP = new Promise<void>((r) => stopped = r);
  createChannel<{ n: number }>({
    id: "sup#feed",
    authorize: () => true,
    publisherRestart: FAST,
    publisher: async ({ key, signal, attempt, publish }) => {
      signals.push(signal);
      if (attempt < 3) throw new Error(`upstream refused (${key})`);
      await publish({ n: attempt });
      await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
      stopped();
    },
  });
  const { server, port } = startHub();
  try {
    const { ws, frames, closed } = await quietly(() =>
      watch(
        port,
        { type: "channel-subscribe", subId: "c", channelId: "sup#feed", key: "k1" },
        (f) => f.some((m) => m.type === "channel"),
      )
    );
    const frame = frames.find((m) => m.type === "channel");
    assertEquals([frame.subId, frame.value], ["c", { n: 3 }]);
    assertEquals(frames.filter((m) => m.type === "error"), []);
    assert(!closed(), "the subscriber stayed connected through the restarts");
    assertEquals(signals.length, 3);
    ws.send(JSON.stringify({ type: "channel-unsubscribe", subId: "c" }));
    await stoppedP; // the key went idle → the producer's signal aborted
    assert(signals[2].aborted);
    ws.close();
  } finally {
    uninstallLiveHub();
    await server.shutdown();
    resetChannels();
  }
});
