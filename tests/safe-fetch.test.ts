// SSRF-safe pinned fetch: HTTP response parsing, and DNS-rebinding protection via
// an injected resolver + transport (no real network).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isForbiddenAddress,
  makePinnedFetch,
  parseHttpResponse,
  type Resolver,
  type Transport,
} from "../src/server/safe-fetch.ts";
import { fetchRemoteImage } from "../src/server/image-optimizer.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function rawResponse(status: number, headers: Record<string, string>, body: string): Uint8Array {
  const head = [`HTTP/1.1 ${status} X`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)]
    .join("\r\n");
  return enc.encode(`${head}\r\n\r\n${body}`);
}

Deno.test("parseHttpResponse frames a content-length body", () => {
  const r = parseHttpResponse(rawResponse(200, { "content-length": "5" }, "hello extra-ignored"));
  assertEquals(r.status, 200);
  assertEquals(dec.decode(r.body), "hello");
});

Deno.test("parseHttpResponse decodes a chunked body", () => {
  const chunked = "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
  const r = parseHttpResponse(rawResponse(200, { "transfer-encoding": "chunked" }, chunked));
  assertEquals(dec.decode(r.body), "hello world");
});

Deno.test("parseHttpResponse reads to end when no framing is given", () => {
  const r = parseHttpResponse(rawResponse(200, {}, "raw body until close"));
  assertEquals(dec.decode(r.body), "raw body until close");
});

// A transport that records what it was asked to connect to and returns canned bytes.
function recordingTransport(
  raw: Uint8Array,
): { transport: Transport; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const transport: Transport = (opts) => {
    calls.push({ ip: opts.ip, port: opts.port, tls: opts.tls, hostname: opts.hostname });
    return Promise.resolve(raw);
  };
  return { transport, calls };
}

Deno.test("pinnedFetch connects to the resolved IP with the original Host/SNI", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34"]);
  const { transport, calls } = recordingTransport(
    rawResponse(200, { "content-length": "3" }, "IMG"),
  );
  const fetchImpl = makePinnedFetch({ resolver, transport });
  const res = await fetchImpl(new URL("https://example.com/a.png"), {});
  assertEquals(res.status, 200);
  assertEquals(dec.decode(new Uint8Array(await res.arrayBuffer())), "IMG");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], { ip: "93.184.216.34", port: 443, tls: true, hostname: "example.com" });
});

Deno.test("pinnedFetch refuses a name that resolves to a private IP (DNS rebinding)", async () => {
  const resolver: Resolver = () => Promise.resolve(["169.254.169.254"]); // cloud metadata
  const { transport, calls } = recordingTransport(rawResponse(200, {}, "secret"));
  const fetchImpl = makePinnedFetch({ resolver, transport });
  const res = await fetchImpl(new URL("https://img.attacker.com/a.png"), {});
  assertEquals(res.status, 502);
  assertEquals(calls.length, 0, "must not connect when the resolved IP is internal");
});

Deno.test("pinnedFetch refuses if ANY resolved IP is internal", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34", "10.0.0.5"]);
  const { transport, calls } = recordingTransport(rawResponse(200, {}, "x"));
  const res = await makePinnedFetch({ resolver, transport })(new URL("https://x.com/a"), {});
  assertEquals(res.status, 502);
  assertEquals(calls.length, 0);
});

Deno.test("pinnedFetch refuses when the name resolves to nothing", async () => {
  const resolver: Resolver = () => Promise.resolve([]);
  const res = await makePinnedFetch({ resolver, transport: () => Promise.reject("nope") })(
    new URL("https://x.com/a"),
    {},
  );
  assertEquals(res.status, 502);
});

Deno.test("pinnedFetch returns a redirect verbatim for the caller to re-validate", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34"]);
  const { transport } = recordingTransport(
    rawResponse(302, { location: "https://evil.example/b.png" }, ""),
  );
  const res = await makePinnedFetch({ resolver, transport })(
    new URL("https://cdn.example.com/a"),
    {},
  );
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "https://evil.example/b.png");
});

Deno.test("fetchRemoteImage closes DNS rebinding end-to-end (allowlisted name → internal IP)", async () => {
  // The host IS allowlisted, but its DNS points at cloud metadata. The pinned fetch
  // resolves + validates, so the optimizer refuses.
  const resolver: Resolver = () => Promise.resolve(["169.254.169.254"]);
  const fetchImpl = makePinnedFetch({
    resolver,
    transport: () => Promise.reject(new Error("should never connect")),
  });
  const out = await fetchRemoteImage(
    new URL("https://img.allowlisted.example/a.png"),
    { allowedHosts: ["img.allowlisted.example"] },
    fetchImpl,
  );
  assertEquals(out, null);
});

Deno.test("fetchRemoteImage fetches when the allowlisted name resolves to a public IP", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34"]);
  const fetchImpl = makePinnedFetch({
    resolver,
    transport: recordingTransport(rawResponse(200, { "content-length": "4" }, "PNG!")).transport,
  });
  const out = await fetchRemoteImage(
    new URL("https://cdn.example.com/a.png"),
    { allowedHosts: ["cdn.example.com"] },
    fetchImpl,
  );
  assert(out);
  assertEquals(dec.decode(out), "PNG!");
});

Deno.test("isForbiddenAddress is re-exported and blocks internal hosts", () => {
  assert(isForbiddenAddress("127.0.0.1"));
  assert(!isForbiddenAddress("example.com"));
});

Deno.test("pinnedFetch rejects a non-http(s) scheme", async () => {
  const res = await makePinnedFetch({})(new URL("ftp://example.com/a"), {});
  assertEquals(res.status, 502);
});

// A tiny smoke check that the request line we build is well-formed HTTP.
Deno.test("pinnedFetch issues a GET with Host + Connection: close", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34"]);
  let sent = "";
  const transport: Transport = (opts) => {
    sent = dec.decode(opts.request);
    return Promise.resolve(rawResponse(200, { "content-length": "1" }, "x"));
  };
  await makePinnedFetch({ resolver, transport })(
    new URL("https://example.com/dir/img.png?w=1"),
    {},
  );
  assertStringIncludes(sent, "GET /dir/img.png?w=1 HTTP/1.1\r\n");
  assertStringIncludes(sent, "Host: example.com\r\n");
  assertStringIncludes(sent, "Connection: close\r\n");
});
