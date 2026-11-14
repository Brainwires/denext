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
import { encodeBase64 } from "@std/encoding/base64";
import {
  fetchDecodedEncoding,
  matchesProxyPrefix,
  proxyToBackend,
  wsBridgesClosed,
} from "../src/build/dev-proxy.ts";
import { fetchDecodesDeflate } from "../src/build/deno-version.ts";
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
    await t.step("a deflate body is relayed with headers that describe its bytes", async () => {
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

/** A raw TCP backend that records the exact request head it receives, then answers 200. */
function startRawBackend() {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const heads: string[] = [];
  const done = (async () => {
    for await (const conn of listener) {
      (async () => {
        const buf = new Uint8Array(65536);
        let text = "";
        while (!text.includes("\r\n\r\n")) {
          const n = await conn.read(buf);
          if (n === null) break;
          text += new TextDecoder().decode(buf.subarray(0, n));
        }
        heads.push(text.split("\r\n\r\n")[0].toLowerCase());
        await conn.write(
          new TextEncoder().encode(
            "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
          ),
        ).catch(() => {});
        try {
          conn.close();
        } catch { /* already closed */ }
      })();
    }
  })();
  return {
    port: (listener.addr as Deno.NetAddr).port,
    heads,
    close: async () => {
      listener.close();
      await done.catch(() => {});
    },
  };
}

Deno.test("proxyToBackend: a client's hop-by-hop headers never reach the backend", async () => {
  const backend = startRawBackend();
  const cfg = { prefixes: ["/api"], target: `http://127.0.0.1:${backend.port}` };
  const url = new URL("http://127.0.0.1:3000/api/thing");
  try {
    const res = await proxyToBackend(
      new Request(url, {
        headers: {
          // Hop-by-hop, and a header the client marks hop-by-hop through `Connection`.
          "connection": "keep-alive, x-session-token",
          "x-session-token": "secret-meant-for-the-proxy-hop",
          "upgrade": "h2c",
          "te": "trailers",
          "keep-alive": "timeout=5",
          "proxy-connection": "keep-alive",
          "proxy-authorization": "Basic cHJveHk6cGFzcw==",
          // End-to-end headers the backend must still get.
          "cookie": "sid=1",
          "authorization": "Bearer t",
          "x-request": "kept",
        },
      }),
      url,
      cfg,
    );
    assertEquals(res.status, 200);
    await res.text();
    const head = backend.heads.at(-1) ?? "";
    for (
      const gone of [
        "upgrade:",
        "te:",
        "keep-alive:",
        "proxy-connection:",
        "proxy-authorization:",
        "x-session-token:",
        "h2c",
      ]
    ) {
      assert(!head.includes(gone), `forwarded ${gone}\n${head}`);
    }
    assert(!/connection: [^\r\n]*x-session-token/.test(head), head);
    for (const kept of ["cookie: sid=1", "authorization: bearer t", "x-request: kept"]) {
      assert(head.includes(kept), `dropped ${kept}\n${head}`);
    }
  } finally {
    await backend.close();
  }
});

/**
 * A WebSocket backend over raw TCP that echoes short text frames and answers a close frame only
 * once `answerClose()` is called: the backend that has not yet answered the proxy's close.
 */
function startHeldCloseBackend(): {
  port: number;
  answerClose: () => void;
  close: () => Promise<void>;
} {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const answer = Promise.withResolvers<void>();
  const tasks: Promise<void>[] = [];
  const enc = new TextEncoder();
  const serveConn = async (conn: Deno.Conn) => {
    try {
      const buf = new Uint8Array(4096);
      const n = await conn.read(buf);
      const head = new TextDecoder().decode(buf.subarray(0, n ?? 0));
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
      const accept = encodeBase64(
        await crypto.subtle.digest(
          "SHA-1",
          enc.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
        ),
      );
      await conn.write(enc.encode(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      ));
      // Client frames are masked and, here, short (< 126 bytes): 2 header bytes + 4 mask bytes.
      while (await conn.read(buf) !== null) {
        const opcode = buf[0] & 0x0f;
        const payload = buf.slice(6, 6 + (buf[1] & 0x7f)).map((b, i) => b ^ buf[2 + (i % 4)]);
        if (opcode === 1) {
          const out = enc.encode(`echo:${new TextDecoder().decode(payload)}`);
          await conn.write(new Uint8Array([0x81, out.length, ...out]));
        } else if (opcode === 8) {
          await answer.promise;
          await conn.write(new Uint8Array([0x88, payload.length, ...payload]));
          break;
        }
      }
    } catch {
      /* the proxy went away */
    } finally {
      conn.close();
    }
  };
  const accepting = (async () => {
    for await (const conn of listener) tasks.push(serveConn(conn));
  })().catch(() => {});
  return {
    port: (listener.addr as Deno.NetAddr).port,
    answerClose: () => answer.resolve(),
    close: async () => {
      answer.resolve();
      listener.close();
      await accepting;
      await Promise.all(tasks);
    },
  };
}

Deno.test("proxyToBackend: wsBridgesClosed waits for the backend to answer the bridge's close", async () => {
  // A client's close makes the bridge close its upstream, and `ws` keeps a 30 s close timer until
  // the backend answers. A test that returned before that answer left the timer to the leak
  // sanitizer on a loaded CI runner; wsBridgesClosed() is what a teardown awaits.
  const backend = startHeldCloseBackend();
  const cfg = { prefixes: ["/ws"], target: `http://127.0.0.1:${backend.port}` };
  const ac = new AbortController();
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      port: 0,
      hostname: "127.0.0.1",
      signal: ac.signal,
      onListen: (a) => listening.resolve(a.port),
    },
    (req) => proxyToBackend(req, new URL(req.url), cfg),
  );
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${await listening.promise}/ws`);
    const echoed = Promise.withResolvers<string>();
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => echoed.resolve(String(e.data));
    ws.onerror = () => echoed.reject(new Error("ws error"));
    assertEquals(await echoed.promise, "echo:ping");
    const closed = Promise.withResolvers<void>();
    ws.onclose = () => closed.resolve();
    ws.close();
    await closed.promise;

    let settled = false;
    const bridges = wsBridgesClosed().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(settled, false, "the backend has not answered the close yet");
    backend.answerClose();
    await bridges;
    assert(settled);
  } finally {
    ac.abort();
    await server.finished;
    await backend.close();
  }
});

Deno.test("fetchDecodedEncoding: deflate counts as decoded only where fetch decodes it", () => {
  // Stock Deno 2.9 hands a deflate body over still encoded; denext's Deno from 3.0.0-denext.17
  // decodes it, and the relayed headers must then drop the stale encoding.
  for (const deflateDecoded of [false, true]) {
    assert(fetchDecodedEncoding("gzip", deflateDecoded));
    assert(fetchDecodedEncoding(" BR ", deflateDecoded));
    assertEquals(fetchDecodedEncoding("deflate", deflateDecoded), deflateDecoded);
    assert(!fetchDecodedEncoding("zstd", deflateDecoded));
    assert(!fetchDecodedEncoding("gzip, deflate", deflateDecoded));
    assert(!fetchDecodedEncoding(null, deflateDecoded));
  }
});

Deno.test("fetchDecodesDeflate: from 3.0.0-denext.17; stock Deno (no marker) never", () => {
  assert(!fetchDecodesDeflate(""));
  assert(!fetchDecodesDeflate("3.0.0-denext.16"));
  assert(!fetchDecodesDeflate("3.0.0-rc.6"));
  assert(fetchDecodesDeflate("3.0.0-denext.17"));
  assert(fetchDecodesDeflate("3.0.0-denext.18"));
});
