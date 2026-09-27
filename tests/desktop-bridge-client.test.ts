// The page side of the desktop bridge (src/desktop/bridge-client.ts) against a fake runtime that
// implements the interface's gate (token, exact Origin, application/json, POST) and SSE events
// with Last-Event-ID replay (tests/helpers/desktop-fake-runtime.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  desktopRpc,
  EVENTS_PATH,
  hasDesktopBridge,
  isDesktopBridgeError,
  MAX_RPC_BODY_BYTES,
  resetDesktopBridgeForTesting,
  RPC_PATH,
  subscribeDesktopEvent,
  TOKEN_HEADER,
} from "../src/desktop/bridge-client.ts";
import {
  createFakeDesktopRuntime,
  FAKE_ORIGIN,
  FAKE_TOKEN,
  until,
} from "./helpers/desktop-fake-runtime.ts";

/** Run `fn` with the fake installed; always restores and resets. */
async function withRuntime(
  runtime: ReturnType<typeof createFakeDesktopRuntime>,
  fn: () => Promise<void>,
): Promise<void> {
  const restore = runtime.install();
  try {
    await fn();
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

const codeOf = (err: unknown) => (err as { code?: string }).code;

Deno.test("desktopRpc: off desktop rejects unavailable and never fetches", async () => {
  const prev = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    return Promise.reject(new Error("no"));
  };
  try {
    assertEquals(hasDesktopBridge(), false);
    const err = await assertRejects(() => desktopRpc("clipboard", "readText", {}));
    assert(isDesktopBridgeError(err));
    assertEquals(codeOf(err), "unavailable");
    assertEquals(fetched, false);
    // A marker without a token (or a token without the marker) is not a bridge either.
    (globalThis as { __denext?: unknown }).__denext = { desktop: true };
    await assertRejects(() => desktopRpc("clipboard", "readText", {}));
    (globalThis as { __denext?: unknown }).__denext = { token: "x" };
    await assertRejects(() => desktopRpc("clipboard", "readText", {}));
    assertEquals(fetched, false);
  } finally {
    globalThis.fetch = prev;
    delete (globalThis as { __denext?: unknown }).__denext;
  }
});

Deno.test("desktopRpc: passes the gate and returns data from the envelope", async () => {
  const rt = createFakeDesktopRuntime({ clipboard: { readText: () => "copied" } });
  await withRuntime(rt, async () => {
    assertEquals(await desktopRpc("clipboard", "readText", {}), "copied");
  });
  const req = rt.requests[0];
  assertEquals(req.method, "POST");
  assertEquals(req.path, RPC_PATH);
  assertEquals(req.headers.get(TOKEN_HEADER), FAKE_TOKEN);
  assertEquals(req.headers.get("content-type"), "application/json");
  assertEquals(req.headers.get("origin"), FAKE_ORIGIN);
  assertEquals(rt.calls, [{ cap: "clipboard", method: "readText", args: {} }]);
});

Deno.test("desktopRpc: a capability outside the allowlist → unavailable", async () => {
  const rt = createFakeDesktopRuntime({ clipboard: { readText: () => "" } });
  await withRuntime(rt, async () => {
    const err = await assertRejects(() => desktopRpc("shell", "openPath", { path: "/x" }));
    assertEquals(codeOf(err), "unavailable");
    assertEquals((err as { cap?: string }).cap, "shell");
    assertEquals((err as { method?: string }).method, "openPath");
  });
  assertEquals(rt.calls.length, 0);
});

Deno.test("desktopRpc: a wrong token is refused by the gate (forbidden)", async () => {
  const rt = createFakeDesktopRuntime({ clipboard: { readText: () => "" } }, { token: "real" });
  const restore = rt.install();
  (globalThis as { __denext?: unknown }).__denext = { desktop: true, token: "forged" };
  try {
    const err = await assertRejects(() => desktopRpc("clipboard", "readText", {}));
    assertEquals(codeOf(err), "forbidden");
  } finally {
    restore();
  }
});

Deno.test("desktopRpc: a capability error keeps its code; the message never carries args", async () => {
  const rt = createFakeDesktopRuntime({
    fs: {
      readFile: () => {
        throw { code: "not_found", message: "no such file" };
      },
    },
  });
  await withRuntime(rt, async () => {
    const err = await assertRejects(() =>
      desktopRpc("fs", "readFile", { path: "secret-token-in-args.txt" })
    );
    assertEquals(codeOf(err), "not_found");
    assert(!(err as Error).message.includes("secret-token-in-args"));
    assert(!(err as Error).message.includes(FAKE_TOKEN));
  });
});

Deno.test("desktopRpc: an over-limit body is refused before sending (too_large)", async () => {
  const rt = createFakeDesktopRuntime({ fs: { writeFile: () => null } });
  await withRuntime(rt, async () => {
    const data = "x".repeat(MAX_RPC_BODY_BYTES + 1);
    const err = await assertRejects(() => desktopRpc("fs", "writeFile", { data }));
    assertEquals(codeOf(err), "too_large");
  });
  assertEquals(rt.requests.length, 0);
});

Deno.test("desktopRpc: no answer within timeoutMs → timeout", async () => {
  const rt = createFakeDesktopRuntime({
    dialogs: { openFile: () => new Promise((r) => setTimeout(() => r({ files: [] }), 200)) },
  });
  await withRuntime(rt, async () => {
    // The fake ignores the abort, so emulate the browser: reject once the signal fires.
    const inner = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("t", "AbortError")));
        inner(input, init).then(resolve, reject);
      });
    const err = await assertRejects(() => desktopRpc("dialogs", "openFile", {}, { timeoutMs: 20 }));
    assertEquals(codeOf(err), "timeout");
    await new Promise((r) => setTimeout(r, 250)); // let the fake's timer finish
  });
});

Deno.test("desktopRpc: a non-envelope answer → bridge_error; a network failure → unavailable", async () => {
  const prev = globalThis.fetch;
  (globalThis as { __denext?: unknown }).__denext = { desktop: true, token: "t" };
  try {
    globalThis.fetch = () => Promise.resolve(new Response("<html>", { status: 500 }));
    assertEquals(codeOf(await assertRejects(() => desktopRpc("a", "b"))), "bridge_error");
    globalThis.fetch = () => Promise.resolve(Response.json({ hello: 1 }));
    assertEquals(codeOf(await assertRejects(() => desktopRpc("a", "b"))), "bridge_error");
    globalThis.fetch = () => Promise.reject(new TypeError("connection refused"));
    assertEquals(codeOf(await assertRejects(() => desktopRpc("a", "b"))), "unavailable");
  } finally {
    globalThis.fetch = prev;
    delete (globalThis as { __denext?: unknown }).__denext;
  }
});

Deno.test("events: off desktop a subscription is a no-op (no request)", () => {
  const prev = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    return Promise.reject(new Error("no"));
  };
  try {
    const stop = subscribeDesktopEvent("menu", "click", () => {});
    stop();
    assertEquals(fetched, false);
  } finally {
    globalThis.fetch = prev;
  }
});

Deno.test("events: frames route by cap/event; the token rides in a header; last unsubscribe closes", async () => {
  const rt = createFakeDesktopRuntime({});
  await withRuntime(rt, async () => {
    const clicks: unknown[] = [];
    const trays: unknown[] = [];
    const stopA = subscribeDesktopEvent("menu", "click", (d) => clicks.push(d));
    const stopB = subscribeDesktopEvent("tray", "click", (d) => trays.push(d));
    await until(() => rt.openStreams() === 1);
    rt.emit("menu", "click", { id: "prefs" });
    rt.emit("tray", "click", { x: 1 });
    rt.emit("menu", "other", { ignored: true });
    await until(() => clicks.length === 1 && trays.length === 1);
    assertEquals(clicks, [{ id: "prefs" }]);
    assertEquals(trays, [{ x: 1 }]);
    const req = rt.requests.find((r) => r.path === EVENTS_PATH)!;
    assertEquals(req.method, "GET");
    assertEquals(req.headers.get(TOKEN_HEADER), FAKE_TOKEN);
    assertEquals(req.headers.get("accept"), "text/event-stream");
    stopA();
    assertEquals(rt.openStreams(), 1);
    stopB();
    await until(() => rt.openStreams() === 0);
  });
});

Deno.test("events: frames that arrive before a handler subscribes are delivered to it (buffer)", async () => {
  const rt = createFakeDesktopRuntime({});
  await withRuntime(rt, async () => {
    const stopMenu = subscribeDesktopEvent("menu", "click", () => {});
    await until(() => rt.openStreams() === 1);
    rt.emit("notifications", "click", { notification: { id: 7 } });
    await new Promise((r) => setTimeout(r, 20));
    const got: unknown[] = [];
    const stop = subscribeDesktopEvent("notifications", "click", (d) => got.push(d));
    await until(() => got.length === 1);
    assertEquals(got, [{ notification: { id: 7 } }]);
    stop();
    stopMenu();
  });
});

Deno.test("events: the runtime's pre-subscribe log is replayed on connect; reconnect sends Last-Event-ID", async () => {
  const rt = createFakeDesktopRuntime({});
  await withRuntime(rt, async () => {
    rt.emit("deepLink", "open", { url: "myapp://a" }); // before the page subscribed
    const got: unknown[] = [];
    const stop = subscribeDesktopEvent("deepLink", "open", (d) => got.push(d));
    await until(() => got.length === 1);
    stop();
    await until(() => rt.openStreams() === 0);
    const stop2 = subscribeDesktopEvent("deepLink", "open", (d) => got.push(d));
    await until(() => rt.openStreams() === 1);
    // A fresh subscription starts a new connection without an id (the state was dropped), so
    // it replays the log: the handler sees the first frame again.
    await until(() => got.length === 2);
    stop2();
  });
});

Deno.test("events: a dropped stream reconnects with Last-Event-ID and only gets newer frames", async () => {
  const rt = createFakeDesktopRuntime({});
  await withRuntime(rt, async () => {
    const got: unknown[] = [];
    const stop = subscribeDesktopEvent("menu", "click", (d) => got.push(d));
    await until(() => rt.openStreams() === 1);
    rt.emit("menu", "click", 1);
    await until(() => got.length === 1);
    rt.dropStreams(); // the runtime drops the connection
    await until(() => rt.requests.filter((r) => r.path === EVENTS_PATH).length >= 2, 5000);
    const again = rt.requests.filter((r) => r.path === EVENTS_PATH).at(-1)!;
    assertEquals(again.headers.get("last-event-id"), "1");
    rt.emit("menu", "click", 2);
    await until(() => got.length === 2);
    assertEquals(got, [1, 2]);
    stop();
  });
});
