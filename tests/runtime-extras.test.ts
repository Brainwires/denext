import { assert, assertEquals } from "@std/assert";
import {
  after,
  connection,
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { userAgent } from "../src/server/user-agent.ts";
import { googleFontUrl } from "../src/runtime/font-google.ts";
import {
  type CacheStore,
  inMemoryCacheStore,
  revalidateTag,
  setCacheStore,
} from "../src/server/cache.ts";

Deno.test("revalidateTag inside a request registers on the deferred queue (async store drained)", async () => {
  const ctx = createRequestContext(new Request("http://x/"));
  let done = false;
  const store: CacheStore = {
    ...inMemoryCacheStore(),
    // Genuinely async, like a KV/Redis delete.
    deleteByTag: async () => {
      await Promise.resolve();
      done = true;
    },
  };
  setCacheStore(store);
  try {
    runWithContext(ctx, () => {
      void revalidateTag("t"); // NOT awaited (common server-action pattern)
    });
    // Registered for draining, and not yet complete synchronously.
    assertEquals(ctx.deferred.length, 1);
    assert(!done);
    // runDeferred (which the app runs after the response) awaits it to completion.
    await runDeferred(ctx);
    assert(done, "the async invalidation must be drained via the deferred queue");
  } finally {
    setCacheStore(inMemoryCacheStore());
  }
});

Deno.test("after() defers callbacks until runDeferred, swallowing throws", async () => {
  const ran: string[] = [];
  const ctx = createRequestContext(new Request("http://x/"));
  runWithContext(ctx, () => {
    after(() => ran.push("a"));
    after(() => {
      throw new Error("boom");
    });
    after(() => ran.push("c"));
  });
  assertEquals(ran, []); // not run yet
  await runDeferred(ctx); // drains; the throwing one is caught
  assertEquals(ran.sort(), ["a", "c"]);
});

Deno.test("after() outside a request runs immediately", () => {
  let ran = false;
  after(() => (ran = true));
  assert(ran);
});

Deno.test("connection() marks the render dynamic and resolves", async () => {
  const ctx = createRequestContext(new Request("http://x/"));
  assert(!ctx.usedDynamicApi, "not dynamic before connection()");
  await runWithContext(ctx, async () => {
    await connection();
  });
  assert(ctx.usedDynamicApi, "connection() opts the render out of static caching");
});

Deno.test("connection() outside a request resolves immediately", async () => {
  await connection(); // must not throw
});

Deno.test("createRequestContext sanitizes a hostile inbound x-request-id", () => {
  // Deno's Headers already reject raw CR/LF, but tabs/spaces/DEL/high-bytes are
  // legal header-value bytes that would still mangle a log line or the echoed
  // x-request-id header — strip everything but safe token characters.
  const ctx = createRequestContext(
    new Request("http://x/", {
      headers: { "x-request-id": " trace 1\t\x7f\x80xyz " },
    }),
  );
  assertEquals(ctx.requestId, "trace1xyz");
  assert(!/[^\x21-\x7E]/.test(ctx.requestId), "only safe token characters survive");
});

Deno.test("createRequestContext bounds the id length and falls back to a UUID", () => {
  const long = "a".repeat(500);
  const bounded = createRequestContext(
    new Request("http://x/", { headers: { "x-request-id": long } }),
  );
  assertEquals(bounded.requestId.length, 200);

  // An all-unsafe header sanitizes to empty → a fresh UUID is minted.
  const empty = createRequestContext(
    new Request("http://x/", { headers: { "x-request-id": "\t\x7f\x80 " } }),
  );
  assert(/^[0-9a-f-]{36}$/.test(empty.requestId), "minted a UUID when nothing safe remained");
});

Deno.test("userAgent parses browser / os / device / bot", () => {
  const chrome = userAgent({
    headers: new Headers({
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }),
  });
  assertEquals(chrome.browser.name, "Chrome");
  assertEquals(chrome.os.name, "Windows");
  assertEquals(chrome.device.type, "desktop");
  assertEquals(chrome.engine.name, "Blink");
  assert(!chrome.isBot);

  const iphone = userAgent({
    headers: new Headers({
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    }),
  });
  assertEquals(iphone.os.name, "iOS");
  assertEquals(iphone.device.type, "mobile");
  assertEquals(iphone.browser.name, "Safari");

  const bot = userAgent({
    headers: new Headers({
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    }),
  });
  assert(bot.isBot);
});

Deno.test("googleFontUrl builds a CSS2 request for weights + italics", () => {
  assertEquals(
    googleFontUrl({ family: "Inter", weights: [400, 700] }),
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap",
  );
  assertEquals(
    googleFontUrl({ family: "Roboto Mono", weights: [400], styles: ["italic"] }),
    "https://fonts.googleapis.com/css2?family=Roboto+Mono:ital,wght@0,400;1,400&display=swap",
  );
});
