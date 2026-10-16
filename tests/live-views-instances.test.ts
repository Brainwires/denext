// Live views across two instances: two replica processes (tests/helpers/live-view-instance.ts)
// share a Redis `LiveViewStore` (the in-process fake server, real RESP over TCP) and one
// `DENEXT_LIVE_VIEW_SECRET`. A view mounted on A takes events, its socket drops, and the
// reconnect lands on B: B takes the sealed snapshot and resumes the model — a `Date` included —
// instead of running `init`, and the store is left empty.

import { assert, assertEquals } from "@std/assert";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { redisClient } from "../src/server/redis.ts";
import { socket, startReplicaProcess } from "./helpers/live-two-instances.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const INSTANCE = new URL("./helpers/live-view-instance.ts", import.meta.url);
const SECRET = { DENEXT_LIVE_VIEW_SECRET: "two-instance-test-secret-0123456789abcdef" };
const startReplica = (url: string, prefix: string) =>
  startReplicaProcess(INSTANCE, [url, prefix], SECRET);

/** The button's text in a rendered counter. */
const shown = (flight: Any[]): string => flight[0].c[0];

Deno.test("live views: a view parked on instance A resumes on instance B from the shared store", async () => {
  const redis = fakeRedis();
  const prefix = `lv-${crypto.randomUUID().slice(0, 8)}:`;
  const [a, b] = await Promise.all([
    startReplica(redis.url, prefix),
    startReplica(redis.url, prefix),
  ]);
  try {
    const { props, token } = await (await fetch(`http://127.0.0.1:${a.port}/props?start=5`)).json();
    const mount = { type: "view-mount", vid: "v1", view: "it-counter", props, token };

    const onA = await socket(a.port);
    onA.send(mount);
    const first = await onA.next((f) => f.type === "view-render", "the first render on A");
    assertEquals(shown(first.flight), "n=5 t=0");
    onA.send({ type: "view-event", vid: "v1", rev: first.rev, h: 0 });
    const patch = await onA.next((f) => f.type === "view-patch", "the patch on A");
    assertEquals(patch.ops, [["r", [0, 0], "n=6 t=1000"]]);
    await onA.close(); // A parks the view and writes the sealed snapshot

    // The snapshot is in the shared store, and nothing in it is readable.
    const client = redisClient(redis.url);
    let stored: unknown = null;
    for (let i = 0; i < 100 && stored === null; i++) {
      stored = await client.command("GET", `${prefix}${first.iid}`);
      if (stored === null) await new Promise((r) => setTimeout(r, 20));
    }
    assert(typeof stored === "string", "A stored the parked view");
    assert(!stored.includes("n=6") && !stored.includes('"n"'), "sealed");

    const onB = await socket(b.port);
    onB.send({ ...mount, resume: first.iid });
    const resumed = await onB.next((f) => f.type === "view-render", "the render on B");
    assertEquals(shown(resumed.flight), "n=6 t=1000", "B carried on from A's model, not init");
    assert(resumed.iid !== first.iid);
    assertEquals(await client.command("GET", `${prefix}${first.iid}`), null, "taken once");
    onB.send({ type: "view-event", vid: "v1", rev: resumed.rev, h: 0 });
    const next = await onB.next((f) => f.type === "view-patch", "the patch on B");
    assertEquals(next.ops, [["r", [0, 0], "n=7 t=2000"]]);
    await onB.close();
    await client.close();
  } finally {
    await Promise.all([a.stop(), b.stop()]);
    await redis.close();
  }
});
