// SPA reverse proxy: prefix matching + `spa.proxy` config validation (loopback guard).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
} from "node:zlib";
import { matchesProxyPrefix, proxyToBackend } from "../src/build/dev-proxy.ts";
import { validateDenextConfig } from "../src/build/paths.ts";
import type { DenextConfig } from "../src/server/config.ts";

Deno.test("matchesProxyPrefix: exact + sub-path, not a partial segment", () => {
  const prefixes = ["/api", "/ws", "/.well-known"];
  assert(matchesProxyPrefix("/api", prefixes));
  assert(matchesProxyPrefix("/api/users", prefixes));
  assert(matchesProxyPrefix("/ws", prefixes));
  assert(matchesProxyPrefix("/.well-known/openid", prefixes));
  // Not proxied.
  assertEquals(matchesProxyPrefix("/apix", prefixes), false); // partial segment
  assertEquals(matchesProxyPrefix("/", prefixes), false);
  assertEquals(matchesProxyPrefix("/assets/app.js", prefixes), false);
});

const spa = (
  proxy: unknown,
): DenextConfig => ({ mode: "spa", spa: { entry: "./src/main.tsx", proxy } } as DenextConfig);

Deno.test("validateDenextConfig: accepts a well-formed loopback proxy", () => {
  validateDenextConfig(spa({ prefixes: ["/api", "/ws"], target: "http://127.0.0.1:3773" }));
  validateDenextConfig(spa({ prefixes: ["/api"], target: "http://localhost:8080" }));
});

Deno.test("validateDenextConfig: rejects a non-loopback target unless allowNonLoopback", () => {
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: ["/api"], target: "https://api.example.com" })),
    Error,
    "loopback",
  );
  // Explicit opt-in is allowed.
  validateDenextConfig(
    spa({ prefixes: ["/api"], target: "https://api.example.com", allowNonLoopback: true }),
  );
});

Deno.test("validateDenextConfig: rejects bad prefixes and target", () => {
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: [], target: "http://127.0.0.1:3773" })),
    Error,
    "spa.proxy.prefixes",
  );
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: ["api"], target: "http://127.0.0.1:3773" })),
    Error,
    "spa.proxy.prefixes",
  );
  assertThrows(
    () => validateDenextConfig(spa({ prefixes: ["/api"], target: "not a url" })),
    Error,
    "spa.proxy.target",
  );
});

// ---- relayed bodies vs. `fetch`'s transparent decoding --------------------------------------
//
// Deno's `fetch` decodes a `gzip` / `br` body but keeps the upstream `Content-Encoding` and the
// ENCODED `Content-Length`. Relaying those headers over the decoded bytes made WebKit fail every
// compressed API response with "cannot decode raw data" (the T3 Code desktop black screen on
// 3.0.0). The invariant: the relayed headers describe the relayed bytes, whatever the backend did.

const PAYLOAD = JSON.stringify({ ok: true, pad: "x".repeat(4096) });

/** A backend that IGNORES Accept-Encoding and answers with the encoding the path names. */
async function startEncodingBackend(): Promise<
  { port: number; seenAcceptEncoding: string[]; close: () => Promise<void> }
> {
  const raw = new TextEncoder().encode(PAYLOAD);
  // Copied out of node:zlib's Buffers: a `Uint8Array<ArrayBuffer>` is what `Response` takes.
  const bodies: Record<string, Uint8Array<ArrayBuffer>> = {
    "/gzip": new Uint8Array(gzipSync(raw)),
    "/br": new Uint8Array(brotliCompressSync(raw)),
    "/deflate": new Uint8Array(deflateSync(raw)),
    "/identity": raw,
  };
  const seenAcceptEncoding: string[] = [];
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    signal: ac.signal,
    onListen: ({ port }) => resolve(port),
  }, (req) => {
    const path = new URL(req.url).pathname;
    seenAcceptEncoding.push(req.headers.get("accept-encoding") ?? "(none)");
    const body = bodies[path];
    if (!body) return new Response("nope", { status: 404 });
    const headers = new Headers({
      "content-type": "application/json",
      "content-length": String(body.byteLength),
    });
    if (path !== "/identity") headers.set("content-encoding", path.slice(1));
    return new Response(body, { headers });
  });
  const port = await promise;
  return {
    port,
    seenAcceptEncoding,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** Decode the relayed bytes per the RELAYED `Content-Encoding`; the result must be the payload. */
function decodeRelayed(encoding: string | null, bytes: Uint8Array): string {
  const buf = encoding === "gzip"
    ? gunzipSync(bytes)
    : encoding === "br"
    ? brotliDecompressSync(bytes)
    : encoding === "deflate"
    ? inflateSync(bytes)
    : bytes;
  return new TextDecoder().decode(buf);
}

Deno.test({
  name: "proxyToBackend: a relayed body is always described by its relayed headers",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const backend = await startEncodingBackend();
  const cfg = { prefixes: ["/"], target: `http://127.0.0.1:${backend.port}` };
  const relay = (path: string) => {
    const url = new URL(`http://127.0.0.1:3000${path}`);
    return proxyToBackend(
      new Request(url, { headers: { "accept-encoding": "gzip, deflate, br, zstd" } }),
      url,
      cfg,
    );
  };
  try {
    for (const enc of ["gzip", "br"]) {
      await t.step(`a ${enc} body fetch decoded loses its stale encoding headers`, async () => {
        const res = await relay(`/${enc}`);
        assertEquals(res.status, 200);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const ce = res.headers.get("content-encoding");
        assertEquals(decodeRelayed(ce, bytes), PAYLOAD);
        // The decoded bytes are relayed as plain (no Content-Encoding) — never labelled with the
        // upstream encoding and its encoded length, which is what broke WebKit.
        assertEquals(ce, null);
        assertEquals(res.headers.get("content-length"), null);
      });
    }
    await t.step("a deflate body (not decoded by fetch) keeps its headers and bytes", async () => {
      const res = await relay("/deflate");
      assertEquals(res.status, 200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const ce = res.headers.get("content-encoding");
      assertEquals(decodeRelayed(ce, bytes), PAYLOAD);
      // Whatever `fetch` did, an announced length must be the relayed length.
      const cl = res.headers.get("content-length");
      if (cl !== null) assertEquals(Number(cl), bytes.byteLength);
    });
    await t.step("an identity body is relayed verbatim with its length", async () => {
      const res = await relay("/identity");
      assertEquals(res.headers.get("content-encoding"), null);
      assertEquals(res.headers.get("content-length"), String(PAYLOAD.length));
      assertEquals(await res.text(), PAYLOAD);
    });
    await t.step("the browser's Accept-Encoding is not forwarded; fetch negotiates its own", () => {
      // `fetch` decodes only what IT advertised: relaying the browser's list (zstd here) would
      // let the backend answer with an encoding fetch leaves encoded, and the strip above
      // would then mislabel it. So the upstream request carries fetch's own defaults.
      assert(backend.seenAcceptEncoding.length >= 4);
      for (const ae of backend.seenAcceptEncoding) {
        assert(ae !== "(none)", "fetch advertised an encoding set");
        assert(!ae.includes("zstd"), `the browser's list leaked upstream: ${ae}`);
      }
    });
  } finally {
    await backend.close();
  }
});
