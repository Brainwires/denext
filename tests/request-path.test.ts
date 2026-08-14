// Focused edge-case coverage for the request-path helpers that other tests only
// touch indirectly: origin resolution (absolute-url.ts), User-Agent parsing
// (user-agent.ts), and the per-request context (request-context.ts) — correlation
// id sanitization, AsyncLocalStorage isolation, and after()/connection().

import { assert, assertEquals } from "@std/assert";
import { absoluteUrl, requestOrigin } from "../src/server/absolute-url.ts";
import { userAgent } from "../src/server/user-agent.ts";
import {
  after,
  connection,
  createRequestContext,
  currentContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";

const reqWith = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

// --- absolute-url.ts ------------------------------------------------------

Deno.test("requestOrigin derives scheme://host from the Host header", () => {
  assertEquals(
    requestOrigin(reqWith("http://internal/path", { host: "example.com" })),
    "http://example.com",
  );
});

Deno.test("requestOrigin falls back to the request URL host when Host is absent", () => {
  assertEquals(requestOrigin(reqWith("https://fallback.test/x")), "https://fallback.test");
});

Deno.test("requestOrigin: canonicalOrigin overrides everything and strips a trailing slash", () => {
  const origin = requestOrigin(
    reqWith("http://x/", { host: "spoof.com", "x-forwarded-host": "evil.com" }),
    { canonicalOrigin: "https://canonical.example/", trustForwardedHeaders: true },
  );
  assertEquals(origin, "https://canonical.example");
});

Deno.test("requestOrigin ignores forwarded headers by default (untrusted)", () => {
  const origin = requestOrigin(
    reqWith("http://x/", {
      host: "real.com",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "evil.com",
    }),
  );
  assertEquals(origin, "http://real.com");
});

Deno.test("requestOrigin honors forwarded headers only when trust is opted in", () => {
  const origin = requestOrigin(
    reqWith("http://x/", {
      host: "real.com",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "cdn.com",
    }),
    { trustForwardedHeaders: true },
  );
  assertEquals(origin, "https://cdn.com");
});

Deno.test("requestOrigin uses only the first value of a comma-separated forwarded header", () => {
  const origin = requestOrigin(
    reqWith("http://x/", { host: "real.com", "x-forwarded-host": "first.com, second.com" }),
    { trustForwardedHeaders: true },
  );
  assertEquals(origin, "http://first.com");
});

Deno.test("absoluteUrl returns an already-absolute URL unchanged", () => {
  const out = absoluteUrl(reqWith("http://x/", { host: "site.com" }), "https://cdn.net/og.png");
  assertEquals(out, "https://cdn.net/og.png");
});

Deno.test("absoluteUrl resolves a root-relative path against the origin", () => {
  const out = absoluteUrl(reqWith("http://x/", { host: "site.com" }), "/opengraph-image");
  assertEquals(out, "http://site.com/opengraph-image");
});

// --- user-agent.ts --------------------------------------------------------

Deno.test("userAgent: an empty UA is a non-bot desktop with empty fields", () => {
  const ua = userAgent(reqWith("http://x/"));
  assertEquals(ua.isBot, false);
  assertEquals(ua.ua, "");
  assertEquals(ua.browser, {});
  assertEquals(ua.device.type, "desktop");
});

Deno.test("userAgent: Chrome on Windows → Chrome/Blink/Windows/desktop", () => {
  const ua = userAgent(reqWith("http://x/", {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  }));
  assertEquals(ua.browser.name, "Chrome");
  assertEquals(ua.engine.name, "Blink");
  assertEquals(ua.os.name, "Windows");
  assertEquals(ua.device.type, "desktop");
});

Deno.test("userAgent: Edge is not misdetected as Chrome", () => {
  const ua = userAgent(reqWith("http://x/", {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0.0.0",
  }));
  assertEquals(ua.browser.name, "Edge");
});

Deno.test("userAgent: iPhone Safari → iOS mobile on WebKit", () => {
  const ua = userAgent(reqWith("http://x/", {
    "user-agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  }));
  assertEquals(ua.os.name, "iOS");
  assertEquals(ua.os.version, "17.0");
  assertEquals(ua.device.type, "mobile");
  assertEquals(ua.engine.name, "WebKit");
});

Deno.test("userAgent: Android without 'Mobile' is a tablet", () => {
  const ua = userAgent(reqWith("http://x/", {
    "user-agent":
      "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  }));
  assertEquals(ua.device.type, "tablet");
  assertEquals(ua.os.name, "Android");
});

Deno.test("userAgent: Googlebot is flagged as a bot", () => {
  const ua = userAgent(reqWith("http://x/", {
    "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  }));
  assertEquals(ua.isBot, true);
});

// --- request-context.ts: correlation id -----------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

Deno.test("createRequestContext mints a UUID when there is no inbound id", () => {
  const ctx = createRequestContext(reqWith("http://x/"));
  assert(UUID_RE.test(ctx.requestId), `expected a UUID, got ${ctx.requestId}`);
});

Deno.test("createRequestContext reuses a clean inbound x-request-id", () => {
  const ctx = createRequestContext(reqWith("http://x/", { "x-request-id": "trace-abc-123" }));
  assertEquals(ctx.requestId, "trace-abc-123");
});

Deno.test("createRequestContext strips control chars/spaces from an inbound id (log-forging)", () => {
  const ctx = createRequestContext(
    reqWith("http://x/", { "x-request-id": "trace 123" }),
  );
  // Space (0x20) and any control chars are outside the safe \x21-\x7E range.
  assertEquals(ctx.requestId, "trace123");
});

Deno.test("createRequestContext length-bounds an overlong inbound id", () => {
  const ctx = createRequestContext(
    reqWith("http://x/", { "x-request-id": "a".repeat(300) }),
  );
  assertEquals(ctx.requestId.length, 200);
});

Deno.test("createRequestContext mints a UUID when the inbound id sanitizes to empty", () => {
  // A header of only spaces/tabs collapses to "" after sanitization → fresh UUID.
  const ctx = createRequestContext(reqWith("http://x/", { "x-request-id": "    \t   " }));
  assert(UUID_RE.test(ctx.requestId), `expected a UUID, got '${ctx.requestId}'`);
});

// --- request-context.ts: AsyncLocalStorage --------------------------------

Deno.test("currentContext is undefined outside a request scope", () => {
  assertEquals(currentContext(), undefined);
});

Deno.test("runWithContext exposes the ctx inside and clears it after", () => {
  const ctx = createRequestContext(reqWith("http://x/"));
  runWithContext(ctx, () => {
    assertEquals(currentContext(), ctx);
  });
  assertEquals(currentContext(), undefined);
});

Deno.test("concurrent request contexts stay isolated across awaits", async () => {
  const a = createRequestContext(reqWith("http://x/a"));
  const b = createRequestContext(reqWith("http://x/b"));
  await Promise.all([
    runWithContext(a, async () => {
      await new Promise((r) => setTimeout(r, 5));
      assertEquals(currentContext(), a, "context A must not see B");
    }),
    runWithContext(b, async () => {
      await new Promise((r) => setTimeout(r, 1));
      assertEquals(currentContext(), b, "context B must not see A");
    }),
  ]);
});

// --- request-context.ts: after() / connection() ---------------------------

Deno.test("after() queues in a context and runDeferred drains it", async () => {
  const ctx = createRequestContext(reqWith("http://x/"));
  const ran: string[] = [];
  runWithContext(ctx, () => {
    after(() => ran.push("one"));
    after(() => ran.push("two"));
  });
  assertEquals(ran, [], "callbacks do not run until the response is produced");
  await runDeferred(ctx);
  assertEquals(ran.sort(), ["one", "two"]);
  assertEquals(ctx.deferred.length, 0, "the queue is drained");
});

Deno.test("runDeferred swallows a throwing after() callback and still runs the rest", async () => {
  const ctx = createRequestContext(reqWith("http://x/"));
  const ran: string[] = [];
  const origErr = console.error;
  console.error = () => {};
  try {
    runWithContext(ctx, () => {
      after(() => {
        throw new Error("boom");
      });
      after(() => ran.push("survivor"));
    });
    await runDeferred(ctx);
  } finally {
    console.error = origErr;
  }
  assertEquals(ran, ["survivor"], "a throwing callback must not abort the others");
});

Deno.test("after() outside a request runs the callback immediately", () => {
  let ran = false;
  after(() => (ran = true));
  assertEquals(ran, true);
});

Deno.test("connection() marks the render dynamic", async () => {
  const ctx = createRequestContext(reqWith("http://x/"));
  await runWithContext(ctx, () => connection());
  assertEquals(ctx.usedDynamicApi, true);
});
