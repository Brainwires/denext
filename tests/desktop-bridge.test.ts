// The desktop capability bridge, runtime side (src/desktop/bridge.ts): the gate (token, exact
// origin, JSON content type, refused preflight), the dispatcher (unavailable / validation /
// cap-error / timeout / output-strip / body cap) and the SSE event channel (replay + gate).
// Driven by calling `bridge.handle` with constructed Requests — no `deno desktop` runtime.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import {
  type DesktopCapability,
  DesktopCapError,
  type StandardSchemaV1,
} from "../src/desktop/extension.ts";
import { echoCapability } from "../src/desktop/caps/echo.ts";

const ORIGIN = "http://127.0.0.1:8000";
const TOKEN = "test-token-1234";

/** A number Standard Schema (for input-validation tests). */
const numberSchema: StandardSchemaV1<number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (
      v,
    ) => (typeof v === "number" ? { value: v } : { issues: [{ message: "want number" }] }),
  },
};

/** An output schema that keeps only `{ a }`, to prove output stripping. */
const stripSchema: StandardSchemaV1<{ a: number }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) => ({ value: { a: Number((v as { a?: unknown })?.a) } }),
  },
};

/** A capability exercising input schema, cap-error, timeout and output-strip. */
const probe: DesktopCapability = {
  name: "probe",
  events: ["tick"],
  methods: {
    double: { input: numberSchema, handler: (n) => (n as number) * 2 },
    boom: {
      handler: () => {
        throw new DesktopCapError("not_found", "no such thing", { status: 404, data: { id: 7 } });
      },
    },
    secretBoom: {
      handler: () => {
        throw new Error("/Users/secret/path leaked");
      },
    },
    hang: { timeoutMs: 20, handler: () => new Promise<never>(() => {}) },
    strip: { output: stripSchema, handler: () => ({ a: 1, b: "drop-me" }) },
  },
};

function rpc(
  body: unknown,
  init: {
    token?: string | null;
    origin?: string | null;
    contentType?: string | null;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(init.headers);
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.set("x-denext-desktop-token", token);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set("origin", origin);
  const contentType = init.contentType === undefined ? "application/json" : init.contentType;
  if (contentType !== null) headers.set("content-type", contentType);
  return new Request(`${ORIGIN}/_denext/desktop/rpc`, {
    method: init.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(
  bridge: ReturnType<typeof createDesktopBridge>,
  req: Request,
): Promise<
  {
    status: number;
    env: {
      ok?: boolean;
      data?: unknown;
      error?: { code?: string; message?: string; data?: unknown };
    };
  }
> {
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assert(res !== null, "expected the bridge to handle the path");
  return { status: res.status, env: await res.json() };
}

Deno.test("rpc: happy path returns the handler result in an ok envelope", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const { status, env } = await call(bridge, rpc({ cap: "echo", method: "ping", args: { hi: 1 } }));
  assertEquals(status, 200);
  assertEquals(env.ok, true);
  assertEquals((env.data as { echo: unknown }).echo, { hi: 1 });
  assertEquals((env.data as { os: string }).os, Deno.build.os);
});

Deno.test("gate: bad token is forbidden", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const { status, env } = await call(
    bridge,
    rpc({ cap: "echo", method: "ping" }, { token: "wrong" }),
  );
  assertEquals(status, 403);
  assertEquals(env.error?.code, "forbidden");
});

Deno.test("gate: missing and mismatched origin are forbidden", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const missing = await call(bridge, rpc({ cap: "echo", method: "ping" }, { origin: null }));
  assertEquals(missing.status, 403);
  assertEquals(missing.env.error?.code, "forbidden");
  const other = await call(
    bridge,
    rpc({ cap: "echo", method: "ping" }, { origin: "http://127.0.0.1:9999" }),
  );
  assertEquals(other.status, 403);
});

Deno.test("gate: wrong content-type is forbidden", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const { status, env } = await call(
    bridge,
    rpc({ cap: "echo", method: "ping" }, { contentType: "text/plain" }),
  );
  assertEquals(status, 415);
  assertEquals(env.error?.code, "forbidden");
});

Deno.test("gate: a CORS preflight is refused with no allow-origin", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const req = rpc(undefined, { method: "OPTIONS" });
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assertEquals(res?.status, 403);
  assertEquals(res?.headers.get("access-control-allow-origin"), null);
});

Deno.test("gate: a DNS-rebinding Host is forbidden (rpc)", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  // A rebinding domain resolves to 127.0.0.1 but the browser sends its NAME as the host, so
  // request.url is non-loopback even though the socket is local. It must be refused.
  const evil = "http://rebind.evil.example:8000";
  const req = new Request(`${evil}/_denext/desktop/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-denext-desktop-token": TOKEN, origin: evil },
    body: JSON.stringify({ cap: "echo", method: "ping", args: "pwned" }),
  });
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assertEquals(res?.status, 403);
  assertEquals((await res!.json()).error?.code, "forbidden");
});

Deno.test("gate: a DNS-rebinding Host is forbidden (events)", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const evil = "http://rebind.evil.example:8000";
  const req = new Request(`${evil}/_denext/desktop/events`, {
    method: "GET",
    headers: { accept: "text/event-stream", "x-denext-desktop-token": TOKEN },
  });
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assertEquals(res?.status, 403);
  await res?.body?.cancel();
});

Deno.test("dispatch: unknown capability or method is unavailable (not an error)", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const noCap = await call(bridge, rpc({ cap: "nope", method: "x" }));
  assertEquals(noCap.status, 404);
  assertEquals(noCap.env.error?.code, "unavailable");
  const noMethod = await call(bridge, rpc({ cap: "echo", method: "nope" }));
  assertEquals(noMethod.env.error?.code, "unavailable");
});

Deno.test("dispatch: input validation failure is a validation error", async () => {
  const bridge = createDesktopBridge([probe]);
  const { status, env } = await call(
    bridge,
    rpc({ cap: "probe", method: "double", args: "not-a-number" }),
  );
  assertEquals(status, 400);
  assertEquals(env.error?.code, "validation");
});

Deno.test("dispatch: a validated arg reaches the handler", async () => {
  const bridge = createDesktopBridge([probe]);
  const { env } = await call(bridge, rpc({ cap: "probe", method: "double", args: 21 }));
  assertEquals(env.data, 42);
});

Deno.test("dispatch: DesktopCapError maps to its code, status and data", async () => {
  const bridge = createDesktopBridge([probe]);
  const { status, env } = await call(bridge, rpc({ cap: "probe", method: "boom" }));
  assertEquals(status, 404);
  assertEquals(env.error?.code, "not_found");
  assertEquals(env.error?.data, { id: 7 });
});

Deno.test("dispatch: an unexpected error never leaks internals in production", async () => {
  const bridge = createDesktopBridge([probe], { dev: false });
  const { status, env } = await call(bridge, rpc({ cap: "probe", method: "secretBoom" }));
  assertEquals(status, 500);
  assertEquals(env.error?.code, "internal");
  assert(!String(env.error?.message).includes("/Users/secret"), "leaked a path");
});

Deno.test("dispatch: a non-cooperative handler is timed out", async () => {
  const bridge = createDesktopBridge([probe]);
  const { status, env } = await call(bridge, rpc({ cap: "probe", method: "hang" }));
  assertEquals(status, 408);
  assertEquals(env.error?.code, "timeout");
});

Deno.test("dispatch: output is stripped to the declared shape", async () => {
  const bridge = createDesktopBridge([probe]);
  const { env } = await call(bridge, rpc({ cap: "probe", method: "strip" }));
  assertEquals(env.data, { a: 1 });
});

Deno.test("body: an oversized content-length is rejected as too_large", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const req = rpc({ cap: "echo", method: "ping" }, {
    headers: { "content-length": String(5 * 1024 * 1024) },
  });
  const { status, env } = await call(bridge, req);
  assertEquals(status, 413);
  assertEquals(env.error?.code, "too_large");
});

Deno.test("registry: a duplicate capability name is rejected at construction", () => {
  assertThrows(
    () => createDesktopBridge([echoCapability, { name: "echo", methods: {} }]),
    Error,
    "duplicate capability",
  );
});

Deno.test("handle: a non-bridge path falls through (null)", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const req = new Request(`${ORIGIN}/index.html`);
  assertEquals(await bridge.handle(req, new URL(req.url), TOKEN), null);
});

// --- events -----------------------------------------------------------------

/** Read up to `max` complete SSE data-frames from a stream, then cancel it. */
async function readFrames(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Array<{ id?: string; data: unknown }>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ id?: string; data: unknown }> = [];
  let buf = "";
  let cur: { id?: string; lines: string[] } = { lines: [] };
  try {
    while (frames.length < max) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (cur.lines.length > 0) {
            frames.push({ id: cur.id, data: JSON.parse(cur.lines.join("\n")) });
          }
          cur = { lines: [] };
        } else if (line.startsWith("id:")) cur.id = line.slice(3).trim();
        else if (line.startsWith("data:")) cur.lines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function eventsRequest(
  init: { token?: string | null; origin?: string | null; lastEventId?: string; method?: string } =
    {},
): Request {
  const headers = new Headers();
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.set("x-denext-desktop-token", token);
  if (init.origin) headers.set("origin", init.origin);
  if (init.lastEventId) headers.set("last-event-id", init.lastEventId);
  headers.set("accept", "text/event-stream");
  return new Request(`${ORIGIN}/_denext/desktop/events`, { method: init.method ?? "GET", headers });
}

Deno.test("events: buffered events are replayed to a fresh subscriber", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  bridge.emit("menu", "click", { id: "open" });
  bridge.emit("menu", "click", { id: "quit" });
  const req = eventsRequest();
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  assertEquals(res?.status, 200);
  assertEquals(res?.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const frames = await readFrames(res!.body!, 2);
  assertEquals(frames.length, 2);
  assertEquals(frames[0].data, { cap: "menu", event: "click", data: { id: "open" } });
  assertEquals(frames[1].id, "2");
});

Deno.test("events: Last-Event-ID replays only newer events", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  bridge.emit("menu", "click", { id: "one" }); // id 1
  bridge.emit("menu", "click", { id: "two" }); // id 2
  const req = eventsRequest({ lastEventId: "1" });
  const res = await bridge.handle(req, new URL(req.url), TOKEN);
  const frames = await readFrames(res!.body!, 1);
  assertEquals(frames[0].id, "2");
  assertEquals(frames[0].data, { cap: "menu", event: "click", data: { id: "two" } });
});

Deno.test("events: gate refuses a bad token and a preflight", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  const bad = await bridge.handle(
    eventsRequest({ token: "wrong" }),
    new URL(`${ORIGIN}/_denext/desktop/events`),
    TOKEN,
  );
  assertEquals(bad?.status, 403);
  await bad?.body?.cancel();
  const pre = await bridge.handle(
    eventsRequest({ method: "OPTIONS" }),
    new URL(`${ORIGIN}/_denext/desktop/events`),
    TOKEN,
  );
  assertEquals(pre?.status, 403);
  assertEquals(pre?.headers.get("access-control-allow-origin"), null);
});

Deno.test("events: ctx.emit rejects an undeclared event name", async () => {
  const bridge = createDesktopBridge([echoCapability]);
  // echo declares only "pong"; emitPong emits "pong" (allowed).
  const okRes = await call(bridge, rpc({ cap: "echo", method: "emitPong", args: { n: 1 } }));
  assertEquals(okRes.env.ok, true);
  // A cap whose handler emits an undeclared event surfaces as an internal error.
  const bad: DesktopCapability = {
    name: "bad",
    events: ["allowed"],
    methods: { go: { handler: (_a, ctx) => (ctx.emit("nope", 1), true) } },
  };
  const b2 = createDesktopBridge([bad]);
  const res = await call(b2, rpc({ cap: "bad", method: "go" }));
  assertEquals(res.status, 500);
  assertEquals(res.env.error?.code, "internal");
});

Deno.test("bridge: a no-deadline method ends with its page's request; a deadline method does not", async () => {
  const seen: Record<string, AbortSignal> = {};
  const waiter: DesktopCapability = {
    name: "waiter",
    methods: {
      // Waits on the page (a sign-in): its signal follows the calling request.
      long: {
        timeoutMs: false,
        handler: (_a, ctx) =>
          new Promise((resolve) => {
            seen.long = ctx.signal;
            ctx.signal.addEventListener("abort", () => resolve("ended with the page"));
          }),
      },
      // A deadline method keeps the deadline signal only.
      short: { handler: (_a, ctx) => (seen.short = ctx.signal, "ok") },
    },
  };
  const bridge = createDesktopBridge([waiter]);
  const page = new AbortController();
  const base = rpc({ cap: "waiter", method: "long", args: null });
  const req = new Request(base, { signal: page.signal });
  const pending = bridge.handle(req, new URL(req.url), TOKEN);
  await new Promise((r) => setTimeout(r, 5));
  assert(seen.long && !seen.long.aborted);
  page.abort(); // the page that called reloaded
  const res = await pending;
  assertEquals((await res!.json()).data, "ended with the page");
  const other = new AbortController();
  const shortReq = new Request(rpc({ cap: "waiter", method: "short", args: null }), {
    signal: other.signal,
  });
  await bridge.handle(shortReq, new URL(shortReq.url), TOKEN);
  other.abort();
  assertEquals(seen.short.aborted, false);
});
