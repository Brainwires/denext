// Two Live replicas in two processes (tests/helpers/live-redis-instance.ts) sharing one Redis
// pub/sub channel, driven over real WebSockets: a channel publish on A reaches B's subscriber, and
// `usePresence` peers on A and B see each other, then see a leave. Run against the fake server
// (tests/redis-pubsub.test.ts) and a real Redis (tests/redis-integration.test.ts).

import { assert, assertEquals } from "@std/assert";

// deno-lint-ignore no-explicit-any
type Any = any;

const INSTANCE = new URL("./live-redis-instance.ts", import.meta.url);
const WAIT_MS = Number(Deno.env.get("DENEXT_TEST_WS_TIMEOUT_MS")) || 20_000;

/** One replica process and the port it serves on. */
export interface Replica {
  port: number;
  stop(): Promise<void>;
}

/** Start a replica; resolves once it prints its port. */
function startReplica(url: string, channel: string): Promise<Replica> {
  return startReplicaProcess(INSTANCE, [url, channel]);
}

/**
 * Start a replica process running `script` with `args`; resolves once it prints `{"port": N}`.
 *
 * @param script The replica module.
 * @param args Its arguments.
 * @param env Extra environment.
 * @returns The replica.
 */
export async function startReplicaProcess(
  script: URL,
  args: string[],
  env: Record<string, string> = {},
): Promise<Replica> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", script.href, ...args],
    env,
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`replica exited before serving: ${text}`);
    text += value;
  }
  const { port } = JSON.parse(text.split("\n")[0]);
  return {
    port,
    async stop() {
      child.kill("SIGTERM");
      await reader.cancel().catch(() => {});
      await child.status;
    },
  };
}

/**
 * A socket on a replica's Live endpoint that records every frame, with a wait for one matching a
 * predicate.
 *
 * @param port The replica's port.
 * @returns The socket's handle.
 */
export async function socket(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/_denext/live`);
  const frames: Any[] = [];
  const waiters: { pred: (f: Any) => boolean; resolve: (f: Any) => void }[] = [];
  ws.onmessage = (ev) => {
    const frame = JSON.parse(ev.data as string);
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.pred(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const next = (pred: (f: Any) => boolean, what: string): Promise<Any> => {
    const seen = frames.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), WAIT_MS);
      waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  };
  const closed = new Promise((resolve) => (ws.onclose = resolve));
  return {
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    next,
    frames,
    async close() {
      ws.close();
      await closed;
    },
  };
}

/** Peer names in a presence-state frame. */
const names = (frame: Any): string[] => frame.peers.map((p: Any) => p.state?.name).sort();

/**
 * Run the two-replica checks against `url`.
 *
 * @param url A Redis URL both replicas can reach.
 */
export async function liveAcrossTwoReplicas(url: string): Promise<void> {
  const channel = `dnx-test:${crypto.randomUUID().slice(0, 8)}`;
  const [a, b] = await Promise.all([startReplica(url, channel), startReplica(url, channel)]);
  const sockets: Awaited<ReturnType<typeof socket>>[] = [];
  try {
    // A channel publish on A reaches a subscriber on B.
    const onB = await socket(b.port);
    sockets.push(onB);
    onB.send({ type: "channel-subscribe", subId: "s1", channelId: "it:chat", key: "room1" });
    await onB.next((f) => f.type === "channel-ready" && f.subId === "s1", "channel-ready");
    const res = await fetch(`http://127.0.0.1:${a.port}/publish?key=room1&text=hello`);
    assertEquals(await res.text(), "ok");
    const pushed = await onB.next((f) => f.type === "channel" && f.subId === "s1", "the push");
    assertEquals(pushed.value, { text: "hello" });

    // Presence: a peer on each replica sees both; a leave on A reaches B.
    const pa = await socket(a.port);
    sockets.push(pa);
    pa.send({ type: "presence-join", room: "doc", state: { name: "A" } });
    await pa.next((f) => f.type === "presence-state" && f.peers.length === 1, "A's own state");
    const pb = await socket(b.port);
    sockets.push(pb);
    pb.send({ type: "presence-join", room: "doc", state: { name: "B" } });
    const bothOnB = await pb.next(
      (f) => f.type === "presence-state" && f.peers.length === 2,
      "B sees A and B",
    );
    assertEquals(names(bothOnB), ["A", "B"]);
    const bothOnA = await pa.next(
      (f) => f.type === "presence-state" && f.peers.length === 2,
      "A sees A and B",
    );
    assertEquals(names(bothOnA), ["A", "B"]);
    const before = pb.frames.length;
    await pa.close();
    const after = await pb.next(
      (f) => f.type === "presence-state" && pb.frames.indexOf(f) >= before && f.peers.length === 1,
      "B sees A leave",
    );
    assertEquals(names(after), ["B"]);
    assert(after.selfId, "B still knows itself");
  } finally {
    for (const s of sockets) await s.close().catch(() => {});
    await Promise.all([a.stop(), b.stop()]);
  }
}
