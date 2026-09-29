// Response compression (`compress`, default on, gzip — Next.js's `compress`; brotli only when
// listed in `{ encodings }`): Accept-Encoding negotiation, every skip rule, streamed bodies staying progressive, and the wiring through
// createApp (config off, the per-route `export const compress = false`, SSE untouched, an
// ISR cache hit honouring the opt-out, and the byte win on a large page).
//
// The streaming tests make no timing assumptions: they read until the bytes they wait for have
// arrived (whatever chunking the encoder and the event loop produce under load), and a generous
// guard only turns a real stall into a failure instead of a hung run.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import zlib from "node:zlib";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import {
  coalesceChunks,
  COMPRESS_THRESHOLD,
  compressEncodings,
  compressOrPassThrough,
  compressResponse,
  isCompressibleType,
  negotiateEncoding,
} from "../src/server/compress.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";
import type { VNode } from "../src/jsx/types.ts";

const BIG = "<p>a compressible row of text</p>\n".repeat(200); // ~6.8 KB
const enc = new TextEncoder();

function req(headers: Record<string, string> = { "accept-encoding": "gzip, br" }, method = "GET") {
  return new Request("http://localhost/x", { method, headers });
}

function html(body: BodyInit | null = BIG, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

/** Decode a response body per its Content-Encoding (identity when absent). */
async function decoded(res: Response): Promise<string> {
  const coding = res.headers.get("content-encoding");
  if (!coding) return await res.text();
  const format = coding === "br" ? "brotli" : coding;
  const body = res.body!.pipeThrough(new DecompressionStream(format as CompressionFormat));
  return await new Response(body).text();
}

/** Fail (instead of hanging) if `promise` has not settled within `ms` — a stall backstop only. */
async function guard<T>(promise: Promise<T>, what: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`stalled: ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, stall]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read decoded text until it contains `marker` (however the chunks were split). */
async function readUntil(
  reader: ReadableStreamDefaultReader<string>,
  marker: string,
): Promise<string> {
  let text = "";
  while (!text.includes(marker)) {
    const r = await guard(reader.read(), `waiting for ${JSON.stringify(marker)}`);
    if (r.done) throw new Error(`stream ended before ${JSON.stringify(marker)}: ${text}`);
    text += r.value;
  }
  return text;
}

// ---- negotiation -----------------------------------------------------------

Deno.test("negotiateEncoding: gzip only by default — a brotli-only client gets identity", () => {
  assertEquals(negotiateEncoding(null), null);
  assertEquals(negotiateEncoding(""), null);
  assertEquals(negotiateEncoding("gzip"), "gzip");
  assertEquals(negotiateEncoding("x-gzip"), "gzip");
  assertEquals(negotiateEncoding("br"), null, "brotli is not produced unless configured");
  assertEquals(negotiateEncoding("gzip, deflate, br"), "gzip");
  assertEquals(negotiateEncoding("*"), "gzip");
  assertEquals(negotiateEncoding("gzip;q=0, br"), null);
  assertEquals(negotiateEncoding("identity"), null);
  assertEquals(negotiateEncoding("deflate"), null);
  assertEquals(negotiateEncoding("GZIP ; Q=1"), "gzip");
  assertEquals(negotiateEncoding("gzip;q=bogus"), null);
});

Deno.test("negotiateEncoding: with brotli listed, q-values decide and the server's order breaks a tie", () => {
  const both = ["br", "gzip"] as const;
  assertEquals(negotiateEncoding("br", both), "br");
  assertEquals(negotiateEncoding("gzip, deflate, br", both), "br", "tie: the first listed");
  assertEquals(negotiateEncoding("gzip, br", ["gzip", "br"]), "gzip", "tie: the first listed");
  assertEquals(negotiateEncoding("br;q=0.5, gzip;q=0.8", both), "gzip");
  assertEquals(negotiateEncoding("br;q=0, gzip", both), "gzip");
  assertEquals(negotiateEncoding("gzip;q=0, br;q=0", both), null);
  assertEquals(negotiateEncoding("*", both), "br");
  assertEquals(negotiateEncoding("*;q=0.5, br;q=0", both), "gzip");
  assertEquals(negotiateEncoding("gzip", []), null, "no codings: identity");
});

Deno.test("compressEncodings: true/omitted → gzip; { encodings } as listed; false → none", () => {
  assertEquals(compressEncodings(undefined), ["gzip"]);
  assertEquals(compressEncodings(true), ["gzip"]);
  assertEquals(compressEncodings({}), ["gzip"]);
  assertEquals(compressEncodings(false), []);
  assertEquals(compressEncodings({ encodings: ["br", "gzip"] }), ["br", "gzip"]);
  assertEquals(
    compressEncodings({ encodings: ["br", "br", "zstd"] }),
    ["br"],
    "deduped, unknown dropped",
  );
  assertEquals(compressEncodings({ encodings: [] }), []);
});

Deno.test("isCompressibleType: text/JSON/JS/XML/SVG yes; SSE, media, fonts, archives no", () => {
  for (
    const t of [
      "text/html; charset=utf-8",
      "text/css",
      "text/plain",
      "application/json",
      "application/javascript",
      "application/xml",
      "application/rss+xml",
      "application/manifest+json",
      "application/ld+json",
      "application/wasm",
      "image/svg+xml",
    ]
  ) assert(isCompressibleType(t), t);
  for (
    const t of [
      null,
      "text/event-stream",
      "image/png",
      "image/webp",
      "font/woff2",
      "font/ttf",
      "video/mp4",
      "audio/mpeg",
      "application/zip",
      "application/gzip",
      "application/octet-stream",
      "application/pdf",
    ]
  ) assert(!isCompressibleType(t), String(t));
});

// ---- encoding --------------------------------------------------------------

Deno.test("compressResponse: gzip — headers rewritten, body round-trips", async () => {
  const res = await compressResponse(
    req({ "accept-encoding": "gzip" }),
    html(BIG, {
      headers: { "content-length": String(BIG.length), etag: '"abc"', "accept-ranges": "bytes" },
    }),
  );
  assertEquals(res.headers.get("content-encoding"), "gzip");
  assertEquals(res.headers.get("vary"), "Accept-Encoding");
  assertEquals(res.headers.get("content-length"), null);
  assertEquals(res.headers.get("accept-ranges"), null);
  assertEquals(res.headers.get("etag"), 'W/"abc"', "a strong ETag is weakened");
  assertEquals(await decoded(res), BIG);
});

Deno.test("compressResponse: brotli when listed, and an existing Vary is extended not replaced", async () => {
  const res = await compressResponse(req(), html(BIG, { headers: { vary: "x-denext-nav" } }), {
    encodings: ["br", "gzip"],
  });
  assertEquals(res.headers.get("content-encoding"), "br");
  assertEquals(res.headers.get("vary"), "x-denext-nav, Accept-Encoding");
  assertEquals(await decoded(res), BIG);
});

Deno.test("compressResponse: status and statusText survive; JSON bodies compress", async () => {
  const payload = { rows: Array.from({ length: 200 }, (_, i) => ({ i, label: `row ${i}` })) };
  const res = await compressResponse(
    req({ "accept-encoding": "gzip" }),
    Response.json(payload, { status: 201, statusText: "Made" }),
  );
  assertEquals(res.status, 201);
  assertEquals(res.statusText, "Made");
  assertEquals(res.headers.get("content-encoding"), "gzip");
  assertEquals(JSON.parse(await decoded(res)), payload);
});

// ---- skip rules ------------------------------------------------------------

/** Assert `res` came back untouched: no coding, body intact. */
async function assertIdentity(res: Response, body: string | null, why: string) {
  assertEquals(res.headers.get("content-encoding"), null, why);
  if (body !== null) assertEquals(await res.text(), body, why);
}

Deno.test("skip: no Accept-Encoding / only identity → identity, but Vary is set", async () => {
  const res = await compressResponse(req({}), html());
  await assertIdentity(res, BIG, "no header");
  assertEquals(res.headers.get("vary"), "Accept-Encoding", "the representation still varies");
  await assertIdentity(
    await compressResponse(req({ "accept-encoding": "deflate" }), html()),
    BIG,
    "deflate only",
  );
});

Deno.test("skip: HEAD, 204, 304, 206 and a Content-Range", async () => {
  await assertIdentity(await compressResponse(req(undefined, "HEAD"), html()), null, "HEAD");
  await assertIdentity(await compressResponse(req(), html(null, { status: 204 })), null, "204");
  await assertIdentity(await compressResponse(req(), html(null, { status: 304 })), null, "304");
  await assertIdentity(
    await compressResponse(
      req(),
      html(BIG, { status: 206, headers: { "content-range": "bytes 0-9/99" } }),
    ),
    BIG,
    "206",
  );
  await assertIdentity(
    await compressResponse(req(), html(BIG, { headers: { "content-range": "bytes */99" } })),
    BIG,
    "content-range",
  );
});

Deno.test("skip: an existing Content-Encoding is never double-encoded", async () => {
  const gz = new Uint8Array(
    await new Response(
      new Blob([BIG]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const res = await compressResponse(
    req(),
    new Response(gz, { headers: { "content-type": "text/html", "content-encoding": "gzip" } }),
  );
  assertEquals(res.headers.get("content-encoding"), "gzip");
  assertEquals(new Uint8Array(await res.arrayBuffer()), gz);
});

Deno.test("skip: text/event-stream is passed through unbuffered", async () => {
  let push!: (s: string) => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (s) => c.enqueue(enc.encode(s));
      push("data: one\n\n");
    },
  });
  const sse = new Response(body, { headers: { "content-type": "text/event-stream" } });
  const res = await compressResponse(req(), sse);
  assert(res === sse, "the very same response object");
  assertEquals(res.headers.get("vary"), null);
  const reader = res.body!.getReader();
  assertEquals(new TextDecoder().decode((await reader.read()).value), "data: one\n\n");
  await reader.cancel();
});

Deno.test("skip: images, fonts, video, archives and untyped bodies", async () => {
  for (const type of ["image/png", "font/woff2", "video/mp4", "application/zip", ""]) {
    // Bytes, not a string: a string body gets an implicit `text/plain` type.
    const res = await compressResponse(
      req(),
      new Response(enc.encode(BIG), { headers: type ? { "content-type": type } : {} }),
    );
    await assertIdentity(res, BIG, type || "(untyped)");
  }
});

Deno.test("skip: Cache-Control no-transform, and a WebSocket upgrade", async () => {
  await assertIdentity(
    await compressResponse(
      req(),
      html(BIG, { headers: { "cache-control": "public, no-transform" } }),
    ),
    BIG,
    "no-transform",
  );
  await assertIdentity(
    await compressResponse(req(), html(BIG, { headers: { upgrade: "websocket" } })),
    BIG,
    "upgrade",
  );
});

Deno.test("skip: a body under the threshold — known length or read within the first tick", async () => {
  const small = "x".repeat(COMPRESS_THRESHOLD - 1);
  const known = await compressResponse(
    req(),
    html(small, { headers: { "content-length": String(small.length) } }),
  );
  await assertIdentity(known, small, "known length");
  assertEquals(known.headers.get("vary"), null, "a small body never varies");
  const json = await compressResponse(req(), Response.json({ ok: true }));
  assertEquals(json.headers.get("content-encoding"), null, "tiny unknown-length JSON");
  assertEquals(await json.json(), { ok: true });
  // …but `identity;q=0` means the client refuses identity: encode even a small body.
  const forced = await compressResponse(
    req({ "accept-encoding": "gzip, identity;q=0" }),
    html(small, { headers: { "content-length": String(small.length) } }),
  );
  assertEquals(forced.headers.get("content-encoding"), "gzip");
  assertEquals(await decoded(forced), small);
});

// ---- streaming -------------------------------------------------------------

/** Decode the bytes of an unfinished gzip / brotli stream (everything flushed so far). */
function decodePartial(coding: "gzip" | "br", bytes: Uint8Array): string {
  const buf = coding === "gzip"
    ? zlib.gunzipSync(bytes, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    : zlib.brotliDecompressSync(bytes, {
      finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
    });
  return new TextDecoder().decode(buf);
}

for (const coding of ["gzip", "br"] as const) {
  Deno.test(`streaming (${coding}): ONE written chunk is decodable within 5 s, the source still open`, async () => {
    // The tripwire for an encoder that buffers until close (Deno 2.9.7's CompressionStream
    // did): the source writes one chunk and never ends, so only a real flush can deliver it.
    const shell = "<!doctype html><main>" + "shell row\n".repeat(200) + "</main>";
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(shell));
      },
    });
    const res = await compressResponse(req({ "accept-encoding": coding }), html(body), {
      encodings: [coding],
    });
    assertEquals(res.headers.get("content-encoding"), coding);
    const reader = res.body!.getReader();
    const deadline = Date.now() + 5_000;
    let received = new Uint8Array(0);
    let text = "";
    while (!text.includes("</main>")) {
      const left = deadline - Date.now();
      assert(left > 0, `no decodable output within 5 s (${received.byteLength} B arrived)`);
      const r = await guard(reader.read(), `the ${coding} flush`, left);
      assert(!r.done, "the source is still open");
      const next = new Uint8Array(received.byteLength + r.value.byteLength);
      next.set(received);
      next.set(r.value, received.byteLength);
      received = next;
      text = decodePartial(coding, received);
    }
    assertEquals(text, shell);
    await reader.cancel();
  });
}

Deno.test("streaming: the first chunk decodes before the source has finished", async () => {
  let release!: () => void;
  const later = new Promise<void>((r) => (release = r));
  const shell = "<!doctype html><html><body><main>shell</main>";
  const tail = "<template>hole</template></body></html>";
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode(shell));
      await later; // a Suspense hole still rendering
      c.enqueue(enc.encode(tail));
      c.close();
    },
  });
  const res = await compressResponse(req({ "accept-encoding": "gzip" }), html(body));
  assertEquals(res.headers.get("content-encoding"), "gzip", "resolved before the source ended");
  const reader = res.body!
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  // The source holds the tail until `release()`, so reading the whole shell first proves the
  // stream is progressive, however the encoder or the event loop chunk it.
  const first = await readUntil(reader, "</main>");
  assertEquals(first, shell, "the shell arrives (decodable) while the hole is pending");
  release();
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += r.value;
  assertEquals(first + rest, shell + tail, "decompressed output equals the source");
});

Deno.test("streaming: same-tick chunks are coalesced into one flush", async () => {
  // The coalescer itself: 500 chunks written in one go leave as one. (Writes that are queued
  // together reach the transform in one microtask run, before its macrotask flush can fire.)
  const coalesce = coalesceChunks();
  const sizes: number[] = [];
  const drained = (async () => {
    for await (const chunk of coalesce.readable) sizes.push(chunk.byteLength);
  })();
  const writer = coalesce.writable.getWriter();
  const rows = Array.from({ length: 500 }, (_, i) => `<li>row ${i}</li>`);
  const writes = rows.map((row) => writer.write(enc.encode(row) as Uint8Array<ArrayBuffer>));
  const closed = writer.close();
  await Promise.all([...writes, closed, drained]);
  assertEquals(sizes, [enc.encode(rows.join("")).byteLength], "one merged chunk");

  // End to end, the coalesced body decodes to the source.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const row of rows) c.enqueue(enc.encode(row));
      c.close();
    },
  });
  const res = await compressResponse(req({ "accept-encoding": "gzip" }), html(body));
  assertEquals(await decoded(res), rows.join(""));
});

Deno.test("streaming: cancelling the compressed body cancels the source", async () => {
  let onCancel!: () => void;
  const cancelled = new Promise<void>((r) => (onCancel = r));
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(BIG));
    },
    cancel() {
      onCancel();
    },
  });
  const res = await compressResponse(req(), html(body));
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  // The cancel travels back up the pipe chain asynchronously: wait for it to arrive.
  await guard(cancelled, "the client disconnect reaching the renderer");
});

Deno.test("streaming: a source that errors at once errors the encoded body (never a locked one)", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.error(new Error("render failed"));
    },
  });
  const source = html(body);
  const res = await compressOrPassThrough(req(), source);
  // The original's body is locked by the sniff, so handing it back would fail the server write.
  assert(res !== source, "an encoded response, not the locked original");
  assertEquals(res.headers.get("content-encoding"), "gzip");
  let error: unknown;
  try {
    await res.arrayBuffer();
  } catch (err) {
    error = err;
  }
  assert(error !== undefined, "the body errors like the identity body would have");
});

// ---- through createApp -----------------------------------------------------

type Modules = Record<string, unknown>;

/** A manifest with a page at `/` (under `layout.tsx` when given) and API routes. */
function manifest(layout: boolean, apis: string[]): RouteManifest {
  const base = {
    kind: "page" as const,
    layoutChain: layout ? ["layout.tsx"] : [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  return {
    pages: [{ ...base, pattern: parsePattern("/"), routePath: "/", filePath: "page.tsx" }],
    api: apis.map((p) => ({
      kind: "api" as const,
      pattern: parsePattern(p),
      routePath: p,
      filePath: `${p}/route.ts`,
    })),
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
}

function appWith(modules: Modules, extra: Record<string, unknown> = {}) {
  const apis = Object.keys(modules).filter((k) => k.endsWith("/route.ts")).map((k) =>
    k.slice(0, -"/route.ts".length)
  );
  return createApp({
    getManifest: () => manifest("layout.tsx" in modules, apis),
    load: (fp: string) => Promise.resolve(modules[fp]),
    csp: "off",
    ...extra,
  });
}

const get = (path: string, encoding: string | null = "gzip, br") =>
  new Request(`http://localhost${path}`, {
    headers: encoding ? { "accept-encoding": encoding } : {},
  });

/** A 10 000-row list page — the scroll-bench shape that motivated compression. */
const ROWS = 10_000;
const ListPage = (_p: PageProps): VNode =>
  h(
    "ul",
    null,
    Array.from({ length: ROWS }, (_, i) =>
      h(
        "li",
        { key: i, class: "row", "data-i": i },
        h("span", null, `Item ${i}`),
        ` ${(i * 7919) % 10007}`,
      )),
  );

Deno.test("createApp: a large page is gzipped by default (≥ 5× smaller); brotli when listed", async () => {
  const app = appWith({ "page.tsx": { default: ListPage } });
  const identity = await app(get("/", null));
  assertEquals(identity.headers.get("content-encoding"), null);
  const plain = new Uint8Array(await identity.arrayBuffer());

  const gz = await app(get("/", "gzip"));
  assertEquals(gz.headers.get("content-encoding"), "gzip");
  assertStringIncludes(gz.headers.get("vary") ?? "", "Accept-Encoding");
  const gzBytes = new Uint8Array(await gz.clone().arrayBuffer());
  assertEquals(await decoded(gz), new TextDecoder().decode(plain));

  const brOnly = await app(get("/", "br"));
  assertEquals(brOnly.headers.get("content-encoding"), null, "brotli is off by default");
  await brOnly.body?.cancel();
  const both = await app(get("/"));
  assertEquals(both.headers.get("content-encoding"), "gzip", "gzip for a gzip + br client");
  await both.body?.cancel();

  const brApp = appWith({ "page.tsx": { default: ListPage } }, {
    compress: { encodings: ["br", "gzip"] },
  });
  const br = await brApp(get("/", "gzip, br"));
  assertEquals(br.headers.get("content-encoding"), "br");
  const brBytes = new Uint8Array(await br.arrayBuffer());
  assert(plain.byteLength > 300_000, `page is large (${plain.byteLength} B)`);
  assert(
    gzBytes.byteLength * 5 < plain.byteLength,
    `gzip ${gzBytes.byteLength} vs ${plain.byteLength}`,
  );
  assert(
    brBytes.byteLength * 5 < plain.byteLength,
    `br ${brBytes.byteLength} vs ${plain.byteLength}`,
  );
});

Deno.test("createApp: compress:false turns it off", async () => {
  const app = appWith({ "page.tsx": { default: ListPage } }, { compress: false });
  const res = await app(get("/"));
  assertEquals(res.headers.get("content-encoding"), null);
  assertEquals(res.headers.get("vary")?.includes("Accept-Encoding") ?? false, false);
  assertStringIncludes(await res.text(), "Item 9999");
});

Deno.test("createApp: `export const compress = false` on the page, a layout, or a route", async () => {
  const page = await appWith({ "page.tsx": { default: ListPage, compress: false } })(get("/"));
  assertEquals(page.headers.get("content-encoding"), null, "page opt-out");
  await page.body?.cancel();

  const Layout = ({ children }: { children?: unknown }) => h("div", null, children as VNode);
  const layout = await appWith({
    "layout.tsx": { default: Layout, compress: false },
    "page.tsx": { default: ListPage },
  })(get("/"));
  assertEquals(layout.headers.get("content-encoding"), null, "inherited from the layout");
  await layout.body?.cancel();

  const routes = {
    "page.tsx": { default: ListPage },
    "/api/on/route.ts": { GET: () => Response.json({ data: BIG }) },
    "/api/off/route.ts": { GET: () => Response.json({ data: BIG }), compress: false },
  };
  const app = appWith(routes);
  const on = await app(get("/api/on"));
  assertEquals(on.headers.get("content-encoding"), "gzip", "a JSON route handler compresses");
  assertEquals(JSON.parse(await decoded(on)), { data: BIG });
  const off = await app(get("/api/off"));
  assertEquals(off.headers.get("content-encoding"), null, "route opt-out");
  assertEquals(await off.json(), { data: BIG });
});

Deno.test("createApp: an SSE route handler is untouched", async () => {
  const app = appWith({
    "page.tsx": { default: ListPage },
    "/api/events/route.ts": {
      GET: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(`data: ${"x".repeat(4096)}\n\n`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    },
  });
  const res = await app(get("/api/events"));
  assertEquals(res.headers.get("content-encoding"), null);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert(first.startsWith("data: xxx"), "the event arrives as-is, before the stream ends");
  await reader.cancel();
});

Deno.test("createApp: a streamed Suspense page stays progressive and decodes to the identity bytes", async () => {
  const render = () => {
    let resolveData!: (v: string) => void;
    const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
    const Slow = (): VNode => h("strong", null, read());
    const Page = (_p: PageProps): VNode =>
      h(
        "div",
        null,
        h("p", null, "x".repeat(2048)),
        h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }),
      );
    return { page: { default: Page }, resolve: (v: string) => resolveData(v) };
  };

  const a = render();
  const identity = await appWith({ "page.tsx": a.page }, { streaming: true })(get("/", null));
  queueMicrotask(() => a.resolve("streamed!"));
  const plain = await identity.text();
  assertStringIncludes(plain, "streamed!");

  const b = render();
  const res = await appWith({ "page.tsx": b.page }, { streaming: true })(get("/", "gzip"));
  assertEquals(res.headers.get("content-encoding"), "gzip");
  const reader = res.body!
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  // The hole resolves only after the shell has been read, so reaching the fallback proves the
  // shell streamed ahead of it, whatever the chunking.
  const first = await readUntil(reader, "Loading…");
  assert(!first.includes("streamed!"), "…before the hole resolved");
  b.resolve("streamed!");
  let rest = "";
  for (let r = await guard(reader.read(), "the rest"); !r.done; r = await reader.read()) {
    rest += r.value;
  }
  assertEquals(first + rest, plain, "decompressed stream equals the uncompressed one");
});

Deno.test("createApp: an ISR cache hit honours the page's compress opt-out", async () => {
  setCacheStore(inMemoryCacheStore());
  const modules = { "page.tsx": { default: ListPage, revalidate: 60, compress: false } };
  const app = appWith(modules, { pageCache: new PageCache() });
  const miss = await app(get("/"));
  assertEquals(miss.headers.get("content-encoding"), null);
  await miss.text();
  const hit = await app(get("/"));
  assertEquals(hit.headers.get("x-denext-cache"), "HIT");
  assertEquals(hit.headers.get("content-encoding"), null, "the opt-out survives the cache");
  await hit.text();

  const cached = appWith({ "page.tsx": { default: ListPage, revalidate: 60 } }, {
    pageCache: new PageCache(),
  });
  await (await cached(get("/"))).text();
  const hit2 = await cached(get("/"));
  assertEquals(hit2.headers.get("x-denext-cache"), "HIT");
  assertEquals(hit2.headers.get("content-encoding"), "gzip", "a plain cache hit compresses");
  await hit2.body?.cancel();
});
