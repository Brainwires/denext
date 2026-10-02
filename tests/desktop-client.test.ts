// `denext/desktop/client` (src/desktop/client.ts): the typed extension proxy and onDesktopEvent,
// against the fake runtime gate (tests/helpers/desktop-fake-runtime.ts).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { desktopExtension, isDesktopBridgeError, onDesktopEvent } from "../src/desktop/client.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { createFakeDesktopRuntime, until } from "./helpers/desktop-fake-runtime.ts";

/** A stand-in Standard Schema carrying only static types. */
function schema<In, Out = In>(): { "~standard": { types?: { input: In; output: Out } } } {
  return { "~standard": {} };
}

/** An extension shaped like `defineDesktopExtension`'s result (the runtime half's type). */
const scanner = {
  name: "scanner",
  methods: {
    listDevices: {
      input: schema<{ kind?: string }>(),
      output: schema<string[]>(),
      handler: (_args: { kind?: string }) => ["a"],
    },
    count: {
      handler: (args: { n: number }) => Promise.resolve(args.n * 2),
    },
  },
};

Deno.test("desktopExtension: calls cap=<name> method=<prop> with the args, typed", async () => {
  const rt = createFakeDesktopRuntime({
    scanner: {
      listDevices: (args) => (args as { kind?: string }).kind === "usb" ? ["usb0"] : [],
      count: (args) => (args as { n: number }).n * 2,
    },
  });
  const restore = rt.install();
  try {
    const client = desktopExtension<{ default: typeof scanner }>("scanner");
    const devices: string[] = await client.listDevices({ kind: "usb" });
    assertEquals(devices, ["usb0"]);
    const n: number = await client.count({ n: 21 });
    assertEquals(n, 42);
    assertEquals(rt.calls.map((c) => `${c.cap}.${c.method}`), [
      "scanner.listDevices",
      "scanner.count",
    ]);
    // @ts-expect-error: the input type comes from the method's schema
    await client.count({ n: "x" }).catch(() => {});
  } finally {
    restore();
  }
});

Deno.test("desktopExtension: the proxy is not a thenable and has no symbol keys", async () => {
  const client = desktopExtension("scanner") as unknown as Record<string | symbol, unknown>;
  assertEquals(client.then, undefined);
  assertEquals(client[Symbol.iterator], undefined);
  // Awaiting it must resolve to the proxy itself, not call `then`.
  assert((await client) === client);
  assertEquals(Object.keys(client), []);
});

Deno.test("desktopExtension: off desktop rejects unavailable (narrowable), no request", async () => {
  const prev = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    return Promise.reject(new Error("no"));
  };
  try {
    const client = desktopExtension<typeof scanner>("scanner");
    const err = await assertRejects(() => client.listDevices({}));
    assert(isDesktopBridgeError(err));
    assertEquals(err.code, "unavailable");
    assertEquals(fetched, false);
  } finally {
    globalThis.fetch = prev;
  }
});

Deno.test("desktopExtension: refuses an empty name", () => {
  let threw = false;
  try {
    desktopExtension("");
  } catch (err) {
    threw = err instanceof TypeError;
  }
  assert(threw);
});

Deno.test("onDesktopEvent: typed handler receives the frame's data", async () => {
  const rt = createFakeDesktopRuntime({});
  const restore = rt.install();
  try {
    const seen: string[] = [];
    const stop = onDesktopEvent<{ id: string }>("scanner", "attached", ({ id }) => seen.push(id));
    await until(() => rt.openStreams() === 1);
    rt.emit("scanner", "attached", { id: "usb1" });
    await until(() => seen.length === 1);
    assertEquals(seen, ["usb1"]);
    stop();
    await until(() => rt.openStreams() === 0);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("desktopExtension: the proxy is read-only, has no `in` keys, and reuses one function per method", () => {
  const client = desktopExtension("scanner") as unknown as Record<string, unknown>;
  const first = client.listDevices;
  assertEquals(typeof first, "function");
  assert(client.listDevices === first, "the same method returns the same function");
  assert(client.count !== first);
  // `in` never claims a method (feature detection must not mistake it for a plain object).
  assertEquals("listDevices" in client, false);
  // Writes, definitions and deletes are refused (TypeError in strict-mode module code).
  assertThrows(() => {
    client.listDevices = () => "hijacked";
  }, TypeError);
  assertThrows(() => Object.defineProperty(client, "count", { value: 1 }), TypeError);
  assertThrows(() => {
    delete client.listDevices;
  }, TypeError);
  assert(client.listDevices === first, "the method survives the refused write and delete");
});
