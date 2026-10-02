// The desktop bridge's SSE event log (src/desktop/bridge-events.ts) driven directly: the bounded
// drop-oldest replay buffer, the `Last-Event-ID` cursor, live fan-out to several subscribers,
// detaching on cancel, and the heartbeat. The gated HTTP route over it is covered in
// tests/desktop-bridge.test.ts.

import { assertEquals, assertThrows } from "@std/assert";
import { DesktopEventLog } from "../src/desktop/bridge-events.ts";

const decoder = new TextDecoder();

/** Read the next chunk of `reader` as text. */
async function next(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return decoder.decode(value);
}

/** The ids of every frame currently queued on a fresh subscription opened at `cursor`. */
async function replayedIds(log: DesktopEventLog, cursor: string | null): Promise<number[]> {
  const stream = log.open(cursor);
  const reader = stream.getReader();
  const ids: number[] = [];
  // Every backlog frame is enqueued synchronously in start(), so the queue holds exactly those.
  const sentinel = log.append("probe", "end", null);
  for (;;) {
    const id = Number(/^id: (\d+)/.exec(await next(reader))![1]);
    if (id === sentinel) break;
    ids.push(id);
  }
  await reader.cancel();
  return ids;
}

Deno.test("DesktopEventLog: ids are monotonic and the replay buffer drops the oldest past its cap", async () => {
  const log = new DesktopEventLog(2);
  assertEquals([log.append("a", "x", 1), log.append("a", "x", 2), log.append("a", "x", 3)], [
    1,
    2,
    3,
  ]);
  assertEquals(await replayedIds(log, null), [2, 3]);
  // A cap below one is clamped to one: only the newest event is retained.
  const tiny = new DesktopEventLog(0);
  tiny.append("a", "x", 1);
  tiny.append("a", "x", 2);
  assertEquals(await replayedIds(tiny, null), [2]);
});

Deno.test("DesktopEventLog: Last-Event-ID resumes after it; a malformed one replays everything", async () => {
  const log = new DesktopEventLog();
  for (let i = 0; i < 4; i++) log.append("deep-links", "open", { i });
  assertEquals(await replayedIds(log, "2"), [3, 4]);
  assertEquals(await replayedIds(log, "99"), []);
  for (const bad of ["", "-1", "1.5", "abc", "2 "]) {
    // replayedIds appends a sentinel each time, so "everything" grows; compare to a fresh replay.
    const all = await replayedIds(log, null);
    assertEquals(await replayedIds(log, bad), [...all, all.at(-1)! + 1], `cursor ${bad}`);
  }
});

Deno.test("DesktopEventLog: live events fan out as SSE frames; a cancelled subscriber is detached", async () => {
  const log = new DesktopEventLog();
  const a = log.open(null).getReader();
  const b = log.open(null).getReader();
  log.append("notifications", "tapped", { id: "n1" });
  const frame = 'id: 1\ndata: {"cap":"notifications","event":"tapped","data":{"id":"n1"}}\n\n';
  assertEquals(await next(a), frame);
  assertEquals(await next(b), frame);

  await a.cancel();
  // Delivery to the remaining subscriber is unaffected by the departed one.
  log.append("notifications", "tapped", { id: "n2" });
  assertEquals(await next(b), frame.replace("id: 1", "id: 2").replace("n1", "n2"));
  await b.cancel();
  log.append("notifications", "tapped", { id: "n3" }); // no subscribers: only buffered
  assertEquals(await replayedIds(log, "2"), [3]);
});

Deno.test("DesktopEventLog: a subscription heartbeats every 15 s until it is cancelled", async () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let handle = 0;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    timers.set(++handle, { fn, ms });
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => void timers.delete(id)) as typeof clearInterval;
  try {
    const log = new DesktopEventLog();
    const reader = log.open(null).getReader();
    assertEquals([...timers.values()].map((t) => t.ms), [15_000]);
    [...timers.values()][0].fn();
    assertEquals(await next(reader), ": ping\n\n");
    await reader.cancel();
    assertEquals(timers.size, 0, "cancelling the stream stops its heartbeat");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

Deno.test("DesktopEventLog: non-JSON data is refused at append and never reaches a subscriber", async () => {
  const log = new DesktopEventLog();
  const live = log.open(null).getReader();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (
    const data of [{ n: 1n }, cycle, {
      toJSON: () => {
        throw "unserializable";
      },
    }]
  ) {
    const err = assertThrows(() => log.append("cap", "evt", data), TypeError);
    assertEquals(
      err.message.startsWith('desktop event "cap/evt" data is not JSON-serializable: '),
      true,
    );
  }
  // Nothing was retained or assigned an id, and the live subscriber is still attached.
  assertEquals(log.append("cap", "evt", { ok: true }), 1);
  assertEquals(await next(live), 'id: 1\ndata: {"cap":"cap","event":"evt","data":{"ok":true}}\n\n');
  await live.cancel();
  // A fresh subscriber's backlog replays cleanly (a refused event cannot poison it).
  assertEquals(await replayedIds(log, null), [1]);
});
