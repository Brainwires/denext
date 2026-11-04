// `createOwnedResources` (src/desktop/owned-resources.ts): per-window backend resources for a
// desktop extension. Events reach the owner window only; a closed owner disposes or detaches its
// resources by policy; the app's quit disposes everything; the replay is bounded per resource.
// Driven through a fake host that records emits and fires the lifecycle hooks by hand.

import { assertEquals, assertThrows } from "@std/assert";
import {
  createOwnedResources,
  type OwnedResources,
  type OwnedResourcesClosedWindow,
  type OwnedResourcesHost,
  type OwnedResourcesWindow,
} from "../src/desktop/owned-resources.ts";
import { DesktopCapError } from "../src/desktop/extension.ts";

interface Sent {
  event: string;
  data: unknown;
  window: string | undefined;
}

function fakeHost(open: OwnedResourcesWindow[] = [{ id: "main", kind: "main" }]) {
  const sent: Sent[] = [];
  const closed = new Set<(info: OwnedResourcesClosedWindow) => void | Promise<void>>();
  const quit = new Set<() => void | Promise<void>>();
  const host: OwnedResourcesHost = {
    emit: (event, data, options) => sent.push({ event, data, window: options?.window }),
    onWindowClosed: (fn) => {
      closed.add(fn);
      return () => closed.delete(fn);
    },
    onAppQuit: (fn) => {
      quit.add(fn);
      return () => quit.delete(fn);
    },
    windows: () => open,
  };
  return {
    host,
    sent,
    open,
    close: async (id: string, appQuitting = false) => {
      const win = open.find((w) => w.id === id) ?? { id, kind: "window" as const };
      open.splice(open.indexOf(win), 1);
      for (const fn of [...closed]) await fn({ ...win, appQuitting });
    },
    quit: async () => {
      for (const fn of [...quit]) await fn();
    },
    hooks: () => closed.size + quit.size,
  };
}

/** The retained data values of `id`, oldest first. */
function dataOf(res: OwnedResources<string>, id: string): unknown[] {
  return res.attach(id, "main").replay.map((entry) => entry.data);
}

/** A dispose that records which ids it saw. */
function recorder() {
  const disposed: string[] = [];
  return { disposed, dispose: (_r: unknown, id: string) => void disposed.push(id) };
}

Deno.test("owned resources: events reach only the owner, wrapped as { id, data }", () => {
  const fake = fakeHost();
  const r = recorder();
  const res = createOwnedResources<string>({ dispose: r.dispose });
  res.connect(fake.host);
  res.add("a", "pty-a", { owner: "w1" });
  res.add("b", "pty-b"); // owner defaults to "main"
  assertEquals(res.emit("a", "output", "hi"), true);
  assertEquals(res.emit("b", "output", "yo"), true);
  assertEquals(fake.sent, [
    { event: "output", data: { id: "a", data: "hi" }, window: "w1" },
    { event: "output", data: { id: "b", data: "yo" }, window: "main" },
  ]);
  assertEquals(res.get("a"), "pty-a");
  assertEquals(res.owner("b"), "main");
});

Deno.test("owned resources: an emit for an unknown id is a no-op returning false", () => {
  const fake = fakeHost();
  const res = createOwnedResources<string>({ dispose: () => {} });
  res.connect(fake.host);
  assertEquals(res.emit("nope", "output", "x"), false);
  assertEquals(fake.sent, []);
});

Deno.test("owned resources: a duplicate add throws", () => {
  const res = createOwnedResources<string>({ dispose: () => {} });
  res.add("a", "x");
  assertThrows(() => res.add("a", "y"), Error, `"a" already exists`);
  assertEquals(res.get("a"), "x");
});

Deno.test("owned resources: detach keeps it alive and ownerless; attach returns the replay", async () => {
  const fake = fakeHost([{ id: "main", kind: "main" }, { id: "w1", kind: "window", key: "term" }]);
  const r = recorder();
  const res = createOwnedResources<string>({
    onOwnerClosed: "detach",
    dispose: r.dispose,
    replay: { maxBytes: 1024 },
  });
  res.connect(fake.host);
  res.add("a", "pty", { owner: "w1" });
  res.emit("a", "output", "one");
  await fake.close("w1");
  assertEquals(r.disposed, []);
  assertEquals(res.get("a"), "pty");
  assertEquals(res.owner("a"), undefined);
  assertEquals(res.detached(), ["a"]);
  res.emit("a", "output", "two"); // retained, sent nowhere
  assertEquals(fake.sent.length, 1);
  assertEquals(res.attach("a", "w2"), {
    replay: [{ event: "output", data: "one" }, { event: "output", data: "two" }],
  });
  assertEquals(res.owner("a"), "w2");
  assertEquals(res.detached(), []);
  res.emit("a", "output", "three");
  assertEquals(fake.sent.at(-1), {
    event: "output",
    data: { id: "a", data: "three" },
    window: "w2",
  });
});

Deno.test("owned resources: attach moves an owned resource; an unknown id is not_found", () => {
  const fake = fakeHost();
  const res = createOwnedResources<string>({ dispose: () => {} });
  res.connect(fake.host);
  res.add("a", "x", { owner: "w1" });
  assertEquals(res.attach("a", "w2"), { replay: [] });
  res.emit("a", "e", 1);
  assertEquals(fake.sent, [{ event: "e", data: { id: "a", data: 1 }, window: "w2" }]);
  const err = assertThrows(() => res.attach("nope", "w1"), DesktopCapError);
  assertEquals(err.code, "not_found");
});

Deno.test("owned resources: a manual detach remembers the owner's key for ownedBy", () => {
  const fake = fakeHost([{ id: "w1", kind: "window", key: "logs" }]);
  const res = createOwnedResources<string>({ dispose: () => {} });
  res.connect(fake.host);
  res.add("a", "x", { owner: "w1" });
  res.add("b", "y", { owner: "w1" });
  assertEquals(res.detach("a"), true);
  assertEquals(res.detach("nope"), false);
  assertEquals(res.ownedBy("w1"), ["b"]);
  assertEquals(res.ownedBy("logs"), ["a"]);
});

Deno.test("owned resources: ownedBy finds detached resources by the closed window's key", async () => {
  const fake = fakeHost([
    { id: "w1", kind: "window", key: "term" },
    { id: "w2", kind: "window", key: "other" },
  ]);
  const res = createOwnedResources<string>({ onOwnerClosed: "detach", dispose: () => {} });
  res.connect(fake.host);
  res.add("a", "x", { owner: "w1" });
  res.add("b", "y", { owner: "w2" });
  res.add("c", "z", { owner: "w3" });
  await fake.close("w1");
  assertEquals(res.ownedBy("term"), ["a"]); // the reopen-by-key restore
  assertEquals(res.ownedBy("w2"), ["b"]); // current owner
  assertEquals(res.ownedBy("other"), []); // b is not detached
  assertEquals(res.ownedBy("w1"), []); // the closed id owns nothing
  res.attach("a", "w9");
  assertEquals(res.ownedBy("term"), []);
});

Deno.test("owned resources: the dispose policy disposes the closed owner's resources only", async () => {
  const fake = fakeHost();
  const r = recorder();
  const res = createOwnedResources<string>({ dispose: r.dispose });
  res.connect(fake.host);
  res.add("a", "x", { owner: "w1" });
  res.add("b", "y", { owner: "w1" });
  res.add("c", "z", { owner: "w2" });
  await fake.close("w1");
  assertEquals(r.disposed.sort(), ["a", "b"]);
  assertEquals(res.get("a"), undefined);
  assertEquals(res.get("c"), "z");
  assertEquals(res.emit("a", "e", 1), false);
});

Deno.test("owned resources: onAppQuit disposes everything, detached included", async () => {
  const fake = fakeHost();
  const r = recorder();
  const res = createOwnedResources<string>({ onOwnerClosed: "detach", dispose: r.dispose });
  res.connect(fake.host);
  res.add("a", "x", { owner: "w1" });
  res.add("b", "y", { owner: "w2" });
  res.detach("b");
  await fake.quit();
  assertEquals(r.disposed.sort(), ["a", "b"]);
  assertEquals(res.detached(), []);
  assertEquals(res.get("a"), undefined);
});

Deno.test("owned resources: a close while the app quits disposes everything, even under detach", async () => {
  const fake = fakeHost();
  const r = recorder();
  const res = createOwnedResources<string>({ onOwnerClosed: "detach", dispose: r.dispose });
  res.connect(fake.host);
  res.add("a", "x", { owner: "w1" });
  res.add("b", "y", { owner: "w2" });
  await fake.close("w1", true);
  assertEquals(r.disposed.sort(), ["a", "b"]);
  assertEquals(res.detached(), []);
});

Deno.test("owned resources: a failing or hanging dispose is logged and never stops the others", async () => {
  const fake = fakeHost();
  const disposed: string[] = [];
  const res = createOwnedResources<string>({
    disposeTimeoutMs: 20,
    dispose: (_r, id) => {
      if (id === "bad") throw new Error("boom");
      if (id === "slow") return new Promise(() => {}); // never settles
      disposed.push(id);
    },
  });
  res.connect(fake.host);
  res.add("bad", "x");
  res.add("slow", "y");
  res.add("ok", "z");
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(String(args[0]));
  try {
    await fake.quit();
  } finally {
    console.error = original;
  }
  assertEquals(disposed, ["ok"]);
  assertEquals(logged.length, 2);
  assertEquals(logged.some((l) => l.includes(`"bad": dispose failed`)), true);
  assertEquals(logged.some((l) => l.includes(`"slow": dispose did not finish in 20 ms`)), true);
});

Deno.test("owned resources: remove disposes one resource", async () => {
  const r = recorder();
  const res = createOwnedResources<string>({ dispose: r.dispose });
  res.add("a", "x");
  assertEquals(await res.remove("a"), true);
  assertEquals(await res.remove("a"), false);
  assertEquals(r.disposed, ["a"]);
});

Deno.test("owned resources: the replay is bounded per resource and drops the oldest whole chunks", () => {
  const res = createOwnedResources<string>({ dispose: () => {}, replay: { maxBytes: 6 } });
  res.add("a", "x");
  res.add("b", "y");
  res.emit("a", "out", "abc");
  res.emit("a", "out", "de");
  res.emit("b", "out", "123456"); // b's own budget
  assertEquals(dataOf(res, "a"), ["abc", "de"]);
  res.emit("a", "out", "fg"); // 3 + 2 + 2 > 6: "abc" goes whole
  assertEquals(dataOf(res, "a"), ["de", "fg"]);
  assertEquals(dataOf(res, "b"), ["123456"]);
});

Deno.test("owned resources: replay sizes are UTF-8 bytes, byteLength, else JSON length", () => {
  const res = createOwnedResources<string>({ dispose: () => {}, replay: { maxBytes: 8 } });
  res.add("a", "x");
  res.emit("a", "out", "é€"); // 2 + 3 = 5 bytes, though 2 characters
  res.emit("a", "out", new Uint16Array([1, 2])); // 4 bytes: 5 + 4 > 8, "é€" goes
  assertEquals(dataOf(res, "a"), [new Uint8Array([1, 0, 2, 0])]);
  res.add("b", "y");
  res.emit("b", "out", { n: 1 }); // {"n":1} = 7 bytes
  res.emit("b", "out", 12); // 2 bytes: 9 > 8, the object goes
  assertEquals(dataOf(res, "b"), [12]);
});

Deno.test("owned resources: an oversized chunk keeps its tail when it is a string or bytes", () => {
  const res = createOwnedResources<string>({ dispose: () => {}, replay: { maxBytes: 4 } });
  res.add("a", "x");
  res.emit("a", "out", "old");
  res.emit("a", "out", "abcdefgh");
  assertEquals(dataOf(res, "a"), ["efgh"]);
  res.emit("a", "out", "xx€€"); // 2 + 6 bytes; the tail cut lands mid-character, so it moves on
  assertEquals(dataOf(res, "a"), ["€"]);
  res.emit("a", "out", new Uint8Array([1, 2, 3, 4, 5, 6]));
  assertEquals(dataOf(res, "a"), [new Uint8Array([3, 4, 5, 6])]);
  const buf = new Uint8Array([9, 8, 7, 6, 5]).buffer;
  res.emit("a", "out", buf);
  const [kept] = dataOf(res, "a");
  assertEquals(new Uint8Array(kept as ArrayBuffer), new Uint8Array([8, 7, 6, 5]));
  res.emit("a", "out", { long: "object" }); // cannot be cut: not retained, the rest stays
  assertEquals(res.attach("a", "main").replay.length, 1);
});

Deno.test("owned resources: retained bytes are a copy", () => {
  const res = createOwnedResources<string>({ dispose: () => {}, replay: { maxBytes: 16 } });
  res.add("a", "x");
  const buf = new Uint8Array([1, 2, 3]);
  res.emit("a", "out", buf);
  buf.fill(0); // the reader reuses its buffer
  assertEquals(dataOf(res, "a"), [new Uint8Array([1, 2, 3])]);
});

Deno.test("owned resources: replay.maxBytes must be a positive integer", () => {
  for (const maxBytes of [0, -1, 1.5, NaN]) {
    assertThrows(
      () => createOwnedResources({ dispose: () => {}, replay: { maxBytes } }),
      RangeError,
    );
  }
});

Deno.test("owned resources: no replay without the option", () => {
  const res = createOwnedResources<string>({ dispose: () => {} });
  res.add("a", "x");
  res.emit("a", "out", "lost");
  assertEquals(dataOf(res, "a"), []);
});

Deno.test("owned resources: unsubscribe stops close and quit handling and delivery", async () => {
  const fake = fakeHost();
  const r = recorder();
  const res = createOwnedResources<string>({ dispose: r.dispose });
  const off = res.connect(fake.host);
  assertEquals(fake.hooks(), 2);
  off();
  assertEquals(fake.hooks(), 0);
  res.add("a", "x", { owner: "w1" });
  await fake.close("w1");
  await fake.quit();
  assertEquals(r.disposed, []);
  assertEquals(res.emit("a", "e", 1), true);
  assertEquals(fake.sent, []);
  res.connect(fake.host); // reconnecting is allowed after the unsubscribe
  assertThrows(() => res.connect(fake.host), Error, "already connected");
});

Deno.test("owned resources: an emit the host refuses throws and is not retained", () => {
  const fake = fakeHost();
  fake.host.emit = () => {
    throw new Error("undeclared event");
  };
  const res = createOwnedResources<string>({ dispose: () => {}, replay: { maxBytes: 64 } });
  res.connect(fake.host);
  res.add("a", "x");
  assertThrows(() => res.emit("a", "bogus", "data"), Error, "undeclared event");
  assertEquals(dataOf(res, "a"), []);
});

Deno.test("owned resources: remove of a resource whose dispose rejects resolves and logs", async () => {
  const res = createOwnedResources<string>({
    dispose: () => Promise.reject(new Error("gone")),
  });
  res.add("a", "x");
  const original = console.error;
  let logged = "";
  console.error = (...args: unknown[]) => void (logged = String(args[0]));
  try {
    assertEquals(await res.remove("a"), true);
  } finally {
    console.error = original;
  }
  assertEquals(logged.includes(`"a": dispose failed`), true);
});

Deno.test("owned resources: the replay keeps each event's name; only data counts toward maxBytes", () => {
  const res = createOwnedResources<string>({ dispose: () => {}, replay: { maxBytes: 4 } });
  res.add("a", "x");
  res.emit("a", "a-very-long-event-name", "ab");
  res.emit("a", "exit", 0); // "0" is 1 byte: 2 + 1 <= 4
  assertEquals(res.attach("a", "main").replay, [
    { event: "a-very-long-event-name", data: "ab" },
    { event: "exit", data: 0 },
  ]);
});

Deno.test("owned resources: replay.events limits which events are kept, not which are sent", () => {
  const fake = fakeHost();
  const res = createOwnedResources<string>({
    dispose: () => {},
    replay: { maxBytes: 64, events: ["data", "exit"] },
  });
  res.connect(fake.host);
  res.add("a", "x");
  res.emit("a", "data", "ls\n");
  res.emit("a", "title", "~/src"); // sent, not kept
  res.emit("a", "exit", { code: 0 });
  assertEquals(fake.sent.map((s) => s.event), ["data", "title", "exit"]);
  assertEquals(res.attach("a", "main").replay, [
    { event: "data", data: "ls\n" },
    { event: "exit", data: { code: 0 } },
  ]);
});
