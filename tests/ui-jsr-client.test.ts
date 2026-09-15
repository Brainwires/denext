// Tests for `src/ui/jsr.ts` (the UI's JSR plugin-search client) and `denext ui --offline`.
// Nothing here touches the network — every request goes through an injected fetch — and the
// file is run under `deno test -A --deny-net` to prove it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { uiBanner, uiCommand, uiServerOptions } from "../src/cli/commands/ui.ts";
import {
  fetchJsrMeta,
  isJsrSpec,
  jsrAvailable,
  type JsrFailure,
  type JsrHit,
  type JsrMetaResult,
  type JsrRequestOptions,
  type JsrSearchOptions,
  type JsrSearchResult,
  searchJsr,
} from "../src/ui/jsr.ts";
import { makeCtx } from "./_cli-coverage-helpers.ts";
import meta from "./fixtures/jsr/meta.json" with { type: "json" };
import badMeta from "./fixtures/jsr/meta-malformed.json" with { type: "json" };
import malformed from "./fixtures/jsr/search-malformed.json" with { type: "json" };
import page from "./fixtures/jsr/search-page.json" with { type: "json" };

const CAP = 64 * 1024;
const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };

/** One request an injected fetch saw. */
interface Seen {
  readonly url: URL;
  readonly init: RequestInit | undefined;
}

/** A fetch that records every request and answers with `respond` — never the network. */
function stubFetch(
  respond: (url: URL) => Response | Promise<Response>,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({ url, init });
    return Promise.resolve(respond(url));
  };
  return { fetch: fake as typeof fetch, seen };
}

/** A JSON response; `headers` override the JSON content type. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_TYPE, ...headers } });
}

/** A body that yields `chunkBytes` per read, forever — counting reads, noting cancellation. */
function endless(chunkBytes: number) {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

/** The reason of a result that must be a refusal. */
function reasonOf(result: JsrSearchResult | JsrMetaResult): JsrFailure["reason"] {
  assert(!result.ok, `expected a refusal, got ${JSON.stringify(result)}`);
  return result.reason;
}

Deno.test("searchJsr normalises a recorded search page and sends a bounded, credential-free GET", async () => {
  const { fetch, seen } = stubFetch(() => json(page));
  const result = await searchJsr("denext", { fetch });
  assert(result.ok);
  assertEquals(result.total, 14);
  const expected: JsrHit[] = [
    {
      scope: "denext",
      name: "openapi",
      version: "0.3.0",
      description:
        "OpenAPI 3.1 for denext: /openapi.json, a docs page, and the `denext openapi` verb.",
      score: 94,
      archived: false,
    },
    {
      scope: "acme",
      name: "denext-sitemap",
      version: "1.2.0-beta.3+build.7",
      description: "Sitemap plugin for denext.",
      score: 71,
      archived: true,
    },
    { scope: "someone", name: "no-score", version: "0.0.1", description: "", archived: false },
  ];
  assertEquals(result.hits, expected);
  assert(!("score" in result.hits[2]), "a null score is omitted, not carried as undefined");
  assertEquals(seen.length, 1);
  const init = seen[0].init!;
  assertEquals(init.method, "GET");
  assertEquals(init.redirect, "error");
  assertEquals(init.credentials, "omit");
  assertEquals(new Headers(init.headers).get("accept"), "application/json");
  assert(init.signal instanceof AbortSignal, "every request carries the deadline signal");
});

Deno.test("searchJsr skips malformed items: non-objects, bad scope/name, bad or missing version", async () => {
  const opts: JsrSearchOptions = { fetch: stubFetch(() => json(malformed)).fetch, limit: 50 };
  const result = await searchJsr("x", opts);
  assert(result.ok);
  assertEquals(result.hits.map((hit) => `@${hit.scope}/${hit.name}`), ["@ok/survivor"]);
  assertEquals(result.total, 1, "a nonsense total falls back to the kept count");
  assertEquals(result.hits[0].score, undefined, "a string score is not a score");
  assertEquals(result.hits[0].archived, false, "only isArchived === true archives");
  // A page that is not { items: [...] } is refused whole.
  for (const body of [[page.items], { items: "nope" }, null, "items"]) {
    const refused = await searchJsr("x", { fetch: stubFetch(() => json(body)).fetch });
    assertEquals(reasonOf(refused), "unexpected response shape");
  }
});

Deno.test("descriptions lose control, zero-width and bidi characters and are capped at 300", async () => {
  const survivor = await searchJsr("x", { fetch: stubFetch(() => json(malformed)).fetch });
  assert(survivor.ok);
  assertEquals(survivor.hits[0].description, "line one [31m red line two evil zero-width");
  const long = "word ".repeat(400) + String.fromCharCode(0x1b);
  const item = { scope: "ab", name: "cd", latestVersion: "1.0.0", description: long };
  const result = await searchJsr("x", {
    fetch: stubFetch(() => json({ items: [item], total: 1 })).fetch,
  });
  assert(result.ok);
  const text = result.hits[0].description;
  assert(Array.from(text).length <= 300, `capped (got ${text.length})`);
  assert(text.endsWith("…"), "a cut description is marked");
  assert(![...text].some((c) => c.charCodeAt(0) < 0x20), "no control character survives");
});

Deno.test("a body over 64 KiB is refused and its stream cancelled mid-read", async () => {
  const body = endless(16 * 1024);
  const result = await searchJsr("x", {
    fetch: stubFetch(() => new Response(body.stream, { headers: JSON_TYPE })).fetch,
  });
  assertEquals(reasonOf(result), "response too large");
  assert(body.state.cancelled, "the stream is cancelled once the cap is crossed");
  assert(body.state.pulls <= 6, `reading stopped at the cap (pulls: ${body.state.pulls})`);
});

Deno.test("an oversized content-length is refused before a byte is read", async () => {
  const body = endless(1024);
  const headers = { ...JSON_TYPE, "content-length": String(CAP + 1) };
  const result = await searchJsr("x", {
    fetch: stubFetch(() => new Response(body.stream, { headers })).fetch,
  });
  assertEquals(reasonOf(result), "response too large");
  assertEquals(body.state.pulls, 0, "nothing was read");
  assert(body.state.cancelled, "the unread body is released");
});

Deno.test("only a JSON content type is read", async () => {
  for (const type of ["text/html", "text/plain", "", "application/javascript"]) {
    const result = await searchJsr("x", {
      fetch: stubFetch(() => json(page, 200, { "content-type": type })).fetch,
    });
    assertEquals(reasonOf(result), "not JSON", type);
  }
  const vendor = await searchJsr("x", {
    fetch: stubFetch(() => json(page, 200, { "content-type": "application/vnd.jsr+json" })).fetch,
  });
  assert(vendor.ok, "a +json type is JSON");
});

Deno.test("a non-2xx response is refused with its status only", async () => {
  for (const status of [400, 404, 429, 500, 503]) {
    const result = await searchJsr("x", {
      fetch: stubFetch(() => json({ items: [] }, status)).fetch,
    });
    assertEquals(reasonOf(result), `HTTP ${status}`);
  }
});

Deno.test("redirects and transport failures are values, never throws", async () => {
  for (const status of [301, 302, 307, 308]) {
    const result = await searchJsr("x", {
      fetch: stubFetch(() => json({}, status, { location: "https://evil.example/" })).fetch,
    });
    assertEquals(reasonOf(result), "redirect refused", String(status));
  }
  // What `redirect: "error"` (or a dead network) does to a real fetch: it rejects.
  const rejects = (() => Promise.reject(new TypeError("redirect"))) as typeof fetch;
  assertEquals(reasonOf(await searchJsr("x", { fetch: rejects })), "unreachable");
  const throws = (() => {
    throw new TypeError("sync");
  }) as typeof fetch;
  assertEquals(reasonOf(await fetchJsrMeta("ab", "cd", { fetch: throws })), "unreachable");
});

Deno.test("the deadline and the caller's signal bound the request and the body read", async () => {
  const never = (() => new Promise<Response>(() => {})) as typeof fetch;
  assertEquals(reasonOf(await searchJsr("x", { fetch: never, timeoutMs: 20 })), "timed out");
  const stalled = new ReadableStream<Uint8Array>(
    { pull: () => new Promise<void>(() => {}) },
    { highWaterMark: 0 },
  );
  const slowBody = stubFetch(() => new Response(stalled, { headers: JSON_TYPE })).fetch;
  assertEquals(
    reasonOf(await fetchJsrMeta("denext", "openapi", { fetch: slowBody, timeoutMs: 20 })),
    "timed out",
  );
  assertEquals(
    reasonOf(await searchJsr("x", { fetch: never, signal: AbortSignal.abort() })),
    "aborted",
  );
  const later = new AbortController();
  setTimeout(() => later.abort(), 10);
  assertEquals(reasonOf(await searchJsr("x", { fetch: never, signal: later.signal })), "aborted");
});

Deno.test("a body that is not strict UTF-8 JSON, or no body at all, is refused", async () => {
  const cases: [Response, string][] = [
    [new Response("{nope", { headers: JSON_TYPE }), "malformed JSON"],
    [new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: JSON_TYPE }), "malformed JSON"],
    [new Response(null, { headers: JSON_TYPE }), "empty response"],
  ];
  for (const [response, reason] of cases) {
    assertEquals(
      reasonOf(await searchJsr("x", { fetch: stubFetch(() => response).fetch })),
      reason,
    );
  }
});

Deno.test("the search URL is always https://api.jsr.io/packages; the query is only a parameter", async () => {
  const { fetch, seen } = stubFetch(() => json({ items: [], total: 0 }));
  const hostile = "  a/../b?x=1#frag@evil.example:81 %2F&limit=999  ";
  await searchJsr(hostile, { fetch, limit: 7 });
  const url = seen[0].url;
  assertEquals(url.origin, "https://api.jsr.io");
  assertEquals(url.pathname, "/packages");
  assertEquals(url.hash, "");
  assertEquals(url.username, "");
  assertEquals([...url.searchParams.keys()], ["query", "limit"]);
  assertEquals(url.searchParams.get("query"), "a/../b?x=1#frag@evil.example:81 %2F&limit=999");
  assertEquals(url.searchParams.get("limit"), "7");
  await searchJsr("de" + String.fromCharCode(0) + "next", { fetch });
  assertEquals(seen[1].url.searchParams.get("query"), "de next", "controls are dropped");
  await searchJsr("x".repeat(500), { fetch });
  assertEquals(seen[2].url.searchParams.get("query")?.length, 100, "the query is capped");
  const limits: [number | undefined, string][] = [
    [0, "1"],
    [-3, "1"],
    [500, "50"],
    [7.9, "7"],
    [Number.NaN, "20"],
    [undefined, "20"],
  ];
  for (const [limit, sent] of limits) {
    const probe = stubFetch(() => json({ items: [], total: 0 }));
    await searchJsr("x", { fetch: probe.fetch, limit });
    assertEquals(probe.seen[0].url.searchParams.get("limit"), sent, String(limit));
  }
});

Deno.test("fetchJsrMeta reads a validated latest from jsr.io and refuses bad names unasked", async () => {
  const { fetch, seen } = stubFetch(() => json(meta));
  const opts: JsrRequestOptions = { fetch };
  assertEquals(await fetchJsrMeta("denext", "openapi", opts), { ok: true, latest: "0.3.0" });
  assertEquals(seen[0].url.href, "https://jsr.io/@denext/openapi/meta.json");
  assertEquals(seen[0].init?.redirect, "error");
  const bad = [
    badMeta,
    { ...meta, latest: undefined },
    { ...meta, latest: "1.0" },
    {
      ...meta,
      latest: 3,
    },
    { ...meta, latest: "1.0.0-" + "a".repeat(100) },
    [meta],
    null,
  ];
  for (const body of bad) {
    const result = await fetchJsrMeta("denext", "openapi", {
      fetch: stubFetch(() => json(body)).fetch,
    });
    assertEquals(reasonOf(result), "no valid latest version", JSON.stringify(body));
  }
  for (const body of [{ ...meta, name: "other" }, { ...meta, scope: "evil" }]) {
    const result = await fetchJsrMeta("denext", "openapi", {
      fetch: stubFetch(() => json(body)).fetch,
    });
    assertEquals(reasonOf(result), "unexpected response shape");
  }
  const guard = stubFetch(() => json(meta));
  const names = [["..", "x1"], ["denext", "openapi/../../evil"], ["a", "bc"], [
    "denext",
    "OpenAPI",
  ]];
  for (const [scope, name] of names) {
    const result = await fetchJsrMeta(scope, name, { fetch: guard.fetch });
    assertEquals(reasonOf(result), "invalid package name", `${scope}/${name}`);
  }
  assertEquals(guard.seen.length, 0, "an invalid name never becomes a request");
});

Deno.test("isJsrSpec follows JSR's scope (2-20) and package-name (2-58) rules", () => {
  const accepted = [
    "@denext/openapi",
    "@ab/cd",
    "@a1/b2",
    "@my-scope/my-package-2",
    `@${"a".repeat(20)}/${"b".repeat(58)}`,
  ];
  const rejected = [
    "",
    "denext/openapi",
    "@denext",
    "@a/openapi",
    "@denext/o",
    `@${"a".repeat(21)}/cd`,
    `@ab/${"b".repeat(59)}`,
    "@-ab/cd",
    "@ab-/cd",
    "@a--b/cd",
    "@ab/c--d",
    "@ab/-cd",
    "@ab/cd-",
    "@AB/cd",
    "@ab/Cd",
    "@ab/c_d",
    "@ab/c.d",
    "@ab/cd/ef",
    "@ab/cd@1.0.0",
    "jsr:@ab/cd",
    " @ab/cd",
    "@ab/cd\n",
  ];
  for (const spec of accepted) assert(isJsrSpec(spec), `accepts ${spec}`);
  for (const spec of rejected) assert(!isJsrSpec(spec), `rejects ${JSON.stringify(spec)}`);
});

Deno.test("jsrAvailable: never offline, never without granted net for the one host a purpose needs, never prompts", async () => {
  const perms = (api: Deno.PermissionState, registry: Deno.PermissionState) => {
    const asked: string[] = [];
    const states: Record<string, Deno.PermissionState> = { "api.jsr.io": api, "jsr.io": registry };
    return {
      asked,
      query(desc: Deno.NetPermissionDescriptor) {
        asked.push(desc.host ?? "");
        return Promise.resolve({ state: states[desc.host ?? ""] ?? "denied" });
      },
    };
  };
  const offline = perms("granted", "granted");
  assertEquals(await jsrAvailable({ offline: true }, "search", offline), false);
  assertEquals(offline.asked, [], "offline does not even ask");
  const search = perms("granted", "denied");
  assertEquals(await jsrAvailable({}, "search", search), true);
  assertEquals(search.asked, ["api.jsr.io"], "a search needs only api.jsr.io");
  const registry = perms("denied", "granted");
  assertEquals(await jsrAvailable({ offline: false }, "registry", registry), true);
  assertEquals(registry.asked, ["jsr.io"], "the registry needs only jsr.io");
  assertEquals(await jsrAvailable({}, "search", perms("denied", "granted")), false);
  assertEquals(await jsrAvailable({}, "registry", perms("granted", "prompt")), false);
  assertEquals(await jsrAvailable({}, "search", perms("prompt", "prompt")), false);
  const broken = { query: () => Promise.reject(new Error("no permission API")) };
  assertEquals(await jsrAvailable({}, "search", broken), false);
});

Deno.test("denext ui --offline reaches the server options and the banner, alongside --read-only", () => {
  const signal = new AbortController().signal;
  const both = uiServerOptions(makeCtx({ flags: { offline: true, "read-only": true } }), signal);
  assertEquals(both.offline, true);
  assertEquals(both.readOnly, true);
  assertEquals(both.signal, signal);
  const plain = uiServerOptions(makeCtx({ flags: { port: 0 } }), signal);
  assertEquals(plain.offline, false);
  assertEquals(plain.strictPort, true);
  const flag = (uiCommand.flags ?? []).find((f) => f.name === "offline");
  assertEquals(flag?.type, "boolean");
  assertStringIncludes(uiCommand.usage ?? "", "--offline");
  const banner = uiBanner("http://127.0.0.1:1/?t=x", "/p", { readOnly: true, offline: true });
  assertStringIncludes(banner, "offline");
  assertStringIncludes(banner, "read-only");
  assert(
    !uiBanner("http://127.0.0.1:1/?t=x", "/p", { readOnly: false, offline: false })
      .includes("offline"),
  );
});
