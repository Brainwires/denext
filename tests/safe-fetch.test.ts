// SSRF-safe pinned fetch: HTTP response parsing, and DNS-rebinding protection via
// an injected resolver + transport (no real network).

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  connectWithAbort,
  isForbiddenAddress,
  makePinnedFetch,
  makeSafeFetch,
  parseHttpResponse,
  type Resolver,
  SafeFetchError,
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
  const err = await assertRejects(
    () => fetchImpl(new URL("https://img.attacker.com/a.png"), {}),
    SafeFetchError,
  );
  assertEquals(err.code, "blocked-address");
  assertEquals(calls.length, 0, "must not connect when the resolved IP is internal");
});

Deno.test("pinnedFetch refuses if ANY resolved IP is internal", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34", "10.0.0.5"]);
  const { transport, calls } = recordingTransport(rawResponse(200, {}, "x"));
  const err = await assertRejects(
    () => makePinnedFetch({ resolver, transport })(new URL("https://x.com/a"), {}),
    SafeFetchError,
  );
  assertEquals(err.code, "blocked-address");
  assertEquals(calls.length, 0);
});

Deno.test("pinnedFetch refuses when the name resolves to nothing", async () => {
  const resolver: Resolver = () => Promise.resolve([]);
  const err = await assertRejects(
    () =>
      makePinnedFetch({ resolver, transport: () => Promise.reject("nope") })(
        new URL("https://x.com/a"),
        {},
      ),
    SafeFetchError,
  );
  assertEquals(err.code, "dns");
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

Deno.test("isForbiddenAddress blocks IPv6 internal ranges, incl. IPv4-mapped bypasses", () => {
  // The bypass class: the URL parser normalizes IPv4-mapped literals to the HEX
  // form, which the old dotted-only regex missed.
  for (
    const bad of [
      "::ffff:7f00:1", // hex-encoded 127.0.0.1 (the exploit)
      "[::ffff:7f00:1]", // bracketed literal form
      "::ffff:a9fe:a9fe", // 169.254.169.254 cloud metadata
      "::ffff:127.0.0.1", // dotted IPv4-mapped
      "::ffff:10.0.0.1", // mapped private
      "::1", // loopback
      "0:0:0:0:0:0:0:1", // unexpanded loopback
      "::", // unspecified
      "::7f00:1", // deprecated IPv4-compatible 127.0.0.1
      "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
      "fc00::1", // unique-local
      "fd12:3456::1", // unique-local
      "fe80::1", // link-local
      "not:a:valid:ip", // malformed → fail closed
    ]
  ) {
    assert(isForbiddenAddress(bad), `should block ${bad}`);
  }
  // Public IPv6 (and public IPv4-mapped) must still be allowed.
  for (
    const ok of [
      "2606:4700:4700::1111", // Cloudflare DNS
      "2001:4860:4860::8888", // Google DNS
      "::ffff:93.184.216.34", // public IPv4-mapped (example.com)
      "::ffff:5db8:d822", // same, hex form
    ]
  ) {
    assert(!isForbiddenAddress(ok), `should allow ${ok}`);
  }
});

Deno.test("pinnedFetch rejects a non-http(s) scheme", async () => {
  const err = await assertRejects(
    () => makePinnedFetch({})(new URL("ftp://example.com/a"), {}),
    SafeFetchError,
  );
  assertEquals(err.code, "unsupported-protocol");
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

// ---- safeFetch (public helper) --------------------------------------------

Deno.test("safeFetch blocks a user URL that resolves to a private IP", async () => {
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["10.0.0.5"]),
    transport: () => Promise.reject(new Error("should not connect")),
  });
  const err = await assertRejects(() => fetch("https://user-supplied.example/x"), SafeFetchError);
  assertEquals(err.code, "blocked-address");
});

Deno.test("safeFetch enforces an allowlist", async () => {
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    transport: () => Promise.resolve(rawResponse(200, { "content-length": "2" }, "ok")),
  });
  const err = await assertRejects(
    () => fetch("https://evil.example/x", { allowedHosts: ["*.trusted.example"] }),
    SafeFetchError,
  );
  assertEquals(err.code, "host-not-allowed");
  // A matching subdomain passes.
  const res = await fetch("https://cdn.trusted.example/x", { allowedHosts: ["*.trusted.example"] });
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
});

Deno.test("safeFetch sends a POST body", async () => {
  let sent = "";
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    transport: (opts) => {
      sent = dec.decode(opts.request);
      return Promise.resolve(rawResponse(200, { "content-length": "4" }, "done"));
    },
  });
  const res = await fetch("https://api.example/hook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assertEquals(res.status, 200);
  assertStringIncludes(sent, "POST /hook HTTP/1.1\r\n");
  assertStringIncludes(sent, "content-type: application/json");
  assertStringIncludes(sent, `Content-Length: ${'{"hello":"world"}'.length}`);
  assertStringIncludes(sent, '{"hello":"world"}');
});

Deno.test("safeFetch follows a redirect, re-validating each hop", async () => {
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    transport: (opts) => {
      const host = new TextDecoder().decode(opts.request).match(/Host: (.+)\r\n/)?.[1];
      if (host === "a.example") {
        return Promise.resolve(rawResponse(302, { location: "https://b.example/final" }, ""));
      }
      return Promise.resolve(rawResponse(200, { "content-length": "5" }, "final"));
    },
  });
  const res = await fetch("https://a.example/start");
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "final");
});

Deno.test("safeFetch stops at maxRedirects", async () => {
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    transport: (opts) => {
      const path = new TextDecoder().decode(opts.request).split(" ")[1];
      return Promise.resolve(
        rawResponse(302, { location: `https://a.example${path}x` }, ""),
      );
    },
  });
  const err = await assertRejects(
    () => fetch("https://a.example/loop", { maxRedirects: 2 }),
    SafeFetchError,
  );
  assertEquals(err.code, "too-many-redirects");
});

Deno.test("safeFetch honors an AbortController signal", async () => {
  const controller = new AbortController();
  controller.abort(); // pre-aborted
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    // A signal-aware transport: reject if already aborted.
    transport: (opts) => {
      if (opts.signal?.aborted) return Promise.reject(new Error("aborted"));
      return Promise.resolve(rawResponse(200, {}, "x"));
    },
  });
  const err = await assertRejects(
    () => fetch("https://api.example/slow", { signal: controller.signal }),
    SafeFetchError,
  );
  assertEquals(err.code, "network");
});

// ---- Response-parser hardening ---------------------------------------------
//
// parseHttpResponse + the chunked decoder are a hand-rolled HTTP/1.1 parser
// introduced by the 0.8.2 SSRF fix — fresh attack surface. The connection is
// pinned to a validated IP, but the *bytes* still come from a remote origin
// (which may be hostile, or a compromised allowlisted host), so the parser must
// never crash, over-read, over-allocate, or be smuggled past its framing.

Deno.test("parser: Content-Length larger than the body does not over-read", () => {
  // A lying Content-Length must not read past the buffer (no OOB / no hang).
  const r = parseHttpResponse(rawResponse(200, { "content-length": "1000" }, "hi"));
  assertEquals(dec.decode(r.body), "hi");
});

Deno.test("parser: negative / non-numeric Content-Length is ignored", () => {
  for (const cl of ["-5", "abc", "0x10", "", " "]) {
    const r = parseHttpResponse(rawResponse(200, { "content-length": cl }, "body"));
    assertEquals(dec.decode(r.body), "body", `CL=${JSON.stringify(cl)}`);
  }
});

Deno.test("parser: request smuggling — Transfer-Encoding wins over Content-Length", () => {
  // Both framing headers present (the classic CL.TE/TE.CL smuggling setup). The
  // parser must commit to chunked (RFC 7230 §3.3.3) and ignore the CL, so the
  // body is the dechunked content, never the CL-truncated prefix.
  const raw = rawResponse(
    200,
    { "content-length": "3", "transfer-encoding": "chunked" },
    "5\r\nhello\r\n0\r\n\r\n",
  );
  const r = parseHttpResponse(raw);
  assertEquals(dec.decode(r.body), "hello");
});

Deno.test("parser: a huge declared chunk size cannot over-read or over-allocate", () => {
  // Chunk claims 0xFFFFFFF bytes but only supplies a few — output is bounded by
  // the bytes actually present, not the declared size (no allocation bomb, no OOB).
  const raw = rawResponse(200, { "transfer-encoding": "chunked" }, "fffffff\r\nAB");
  const r = parseHttpResponse(raw);
  assert(r.body.byteLength <= 2, `body bounded by actual bytes, got ${r.body.byteLength}`);
});

Deno.test("parser: chunk extensions are ignored", () => {
  const raw = rawResponse(
    200,
    { "transfer-encoding": "chunked" },
    "5;name=value\r\nhello\r\n0\r\n\r\n",
  );
  assertEquals(dec.decode(parseHttpResponse(raw).body), "hello");
});

Deno.test("parser: a non-hex chunk size is rejected, not silently mis-framed", () => {
  const raw = rawResponse(200, { "transfer-encoding": "chunked" }, "zz\r\nhello\r\n0\r\n\r\n");
  assertThrows(() => parseHttpResponse(raw), Error, "malformed chunk size");
});

Deno.test("parser: bare-LF header block is not a valid terminator (no smuggling)", () => {
  // Only CRLFCRLF terminates the header block; a bare-LF response can't sneak a
  // body past the framing boundary.
  const raw = enc.encode("HTTP/1.1 200 OK\nContent-Length: 5\n\nhello");
  assertThrows(() => parseHttpResponse(raw), Error, "no header terminator");
});

Deno.test("parser: a missing header terminator is rejected", () => {
  const raw = enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 5"); // never terminated
  assertThrows(() => parseHttpResponse(raw), Error, "no header terminator");
});

Deno.test("parser: a malformed status line is rejected", () => {
  const raw = enc.encode("HTTP/1.1 notanumber OK\r\n\r\nbody");
  assertThrows(() => parseHttpResponse(raw), Error, "malformed HTTP status");
});

Deno.test("parser: an invalid header name is skipped, not fatal", () => {
  // A header with an illegal name (space) must be dropped without aborting the
  // whole parse — the valid headers and body still come through.
  const raw = enc.encode(
    "HTTP/1.1 200 OK\r\nbad name: x\r\nContent-Length: 2\r\n\r\nhi",
  );
  const r = parseHttpResponse(raw);
  assertEquals(r.status, 200);
  assertEquals(dec.decode(r.body), "hi");
});

// A transport that records every request's decoded text (method line + headers +
// body), so multi-hop redirect behavior can be asserted per hop.
function scriptedTransport(
  respond: (req: string, hop: number) => Uint8Array,
): { transport: Transport; requests: string[] } {
  const requests: string[] = [];
  const transport: Transport = (opts) => {
    const text = dec.decode(opts.request);
    const hop = requests.length;
    requests.push(text);
    return Promise.resolve(respond(text, hop));
  };
  return { transport, requests };
}

Deno.test("safeFetch downgrades POST→GET (drops body) on a 303 redirect", async () => {
  const { transport, requests } = scriptedTransport((_req, hop) =>
    hop === 0
      ? rawResponse(303, { location: "https://a.example/done" }, "")
      : rawResponse(200, { "content-length": "2" }, "ok")
  );
  const fetch = makeSafeFetch({ resolver: () => Promise.resolve(["93.184.216.34"]), transport });
  const res = await fetch("https://a.example/submit", { method: "POST", body: "payload" });
  assertEquals(res.status, 200);
  assertEquals(requests.length, 2);
  assertStringIncludes(requests[0], "POST /submit HTTP/1.1\r\n");
  assertStringIncludes(requests[0], "payload");
  // Second hop is a GET with no body (303 always downgrades).
  assertStringIncludes(requests[1], "GET /done HTTP/1.1\r\n");
  assert(!requests[1].includes("payload"), "the body is dropped on the downgraded GET");
  assert(!/Content-Length:/i.test(requests[1]), "no Content-Length on the bodyless GET");
});

Deno.test("safeFetch downgrades POST→GET on a 301/302 redirect", async () => {
  for (const status of [301, 302]) {
    const { transport, requests } = scriptedTransport((_req, hop) =>
      hop === 0
        ? rawResponse(status, { location: "https://a.example/next" }, "")
        : rawResponse(200, { "content-length": "1" }, "x")
    );
    const fetch = makeSafeFetch({ resolver: () => Promise.resolve(["93.184.216.34"]), transport });
    await fetch("https://a.example/start", { method: "POST", body: "data" });
    assertStringIncludes(requests[1], "GET /next HTTP/1.1\r\n", `status ${status} downgrades`);
    assert(!requests[1].includes("data"), `status ${status} drops the body`);
  }
});

Deno.test("safeFetch preserves method + body across a 307 redirect", async () => {
  const { transport, requests } = scriptedTransport((_req, hop) =>
    hop === 0
      ? rawResponse(307, { location: "https://a.example/moved" }, "")
      : rawResponse(200, { "content-length": "2" }, "ok")
  );
  const fetch = makeSafeFetch({ resolver: () => Promise.resolve(["93.184.216.34"]), transport });
  await fetch("https://a.example/start", { method: "POST", body: "keepme" });
  assertStringIncludes(requests[1], "POST /moved HTTP/1.1\r\n", "307 preserves the method");
  assertStringIncludes(requests[1], "keepme", "307 preserves the body");
});

Deno.test("safeFetch: the timeout actually firing surfaces a network error", async () => {
  // A transport that never responds on its own — only the combined timeout signal
  // ends it. Proves timeoutMs elapsing (not just a pre-aborted controller) works.
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    transport: (opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const err = await assertRejects(
    () => fetch("https://slow.example/x", { timeoutMs: 20 }),
    SafeFetchError,
  );
  assertEquals(err.code, "network");
});

Deno.test("safeFetch allowlist excludes the apex of a *.domain entry", async () => {
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    transport: () => Promise.resolve(rawResponse(200, { "content-length": "2" }, "ok")),
  });
  const err = await assertRejects(
    () => fetch("https://trusted.example/x", { allowedHosts: ["*.trusted.example"] }),
    SafeFetchError,
  );
  assertEquals(err.code, "host-not-allowed", "the bare apex must NOT match *.trusted.example");
});

Deno.test("pinnedFetch strips caller-supplied framing/host headers", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34"]);
  let sent = "";
  const transport: Transport = (opts) => {
    sent = dec.decode(opts.request);
    return Promise.resolve(rawResponse(200, { "content-length": "1" }, "x"));
  };
  await makePinnedFetch({ resolver, transport })(new URL("https://example.com/a"), {
    headers: {
      host: "evil.attacker.test",
      "content-length": "999",
      "transfer-encoding": "chunked",
      "accept-encoding": "gzip",
      "x-keep": "yes",
    },
  });
  assert(!sent.includes("evil.attacker.test"), "a caller Host is ignored (framing is managed)");
  assertStringIncludes(sent, "Host: example.com\r\n");
  assertStringIncludes(sent, "Accept-Encoding: identity\r\n");
  assert(!/transfer-encoding/i.test(sent), "caller Transfer-Encoding stripped");
  assert(!sent.includes("gzip"), "caller Accept-Encoding stripped (identity is forced)");
  assertStringIncludes(sent, "x-keep: yes", "a non-managed header still passes through");
});

Deno.test("pinnedFetch yields a null body for 204 / 304 responses", async () => {
  const resolver: Resolver = () => Promise.resolve(["93.184.216.34"]);
  for (const status of [204, 304]) {
    const res = await makePinnedFetch({
      resolver,
      transport: () => Promise.resolve(rawResponse(status, {}, "")),
    })(new URL("https://example.com/a"), {});
    assertEquals(res.status, status);
    assertEquals(res.body, null, `status ${status} has no body`);
  }
});

Deno.test("isForbiddenAddress blocks malformed / broadcast / multicast / protocol IPv4", () => {
  for (
    const bad of [
      "999.1.1.1", // octet > 255 → fail closed
      "256.0.0.1", // octet > 255
      "255.255.255.255", // limited broadcast (a >= 224)
      "224.0.0.1", // multicast 224/4
      "240.0.0.1", // reserved 240/4
      "192.0.0.1", // IETF protocol assignments 192.0.0.0/24
    ]
  ) {
    assert(isForbiddenAddress(bad), `should block ${bad}`);
  }
  // A public unicast address is still allowed.
  assert(!isForbiddenAddress("93.184.216.34"));
  assert(!isForbiddenAddress("8.8.8.8"));
});

Deno.test("safeFetch sends a Uint8Array body with its Content-Length", async () => {
  let sent: Uint8Array = new Uint8Array();
  const fetch = makeSafeFetch({
    resolver: () => Promise.resolve(["93.184.216.34"]),
    transport: (opts) => {
      sent = opts.request;
      return Promise.resolve(rawResponse(200, { "content-length": "2" }, "ok"));
    },
  });
  const bytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
  await fetch("https://api.example/upload", { method: "POST", body: bytes });
  const text = dec.decode(sent);
  assertStringIncludes(text, "Content-Length: 4\r\n");
  // The raw body bytes trail the header block verbatim.
  assertEquals(sent.subarray(sent.length - 4), bytes);
});

Deno.test("safeFetch resolves a relative redirect Location against the current URL", async () => {
  const { transport, requests } = scriptedTransport((_req, hop) =>
    hop === 0
      ? rawResponse(302, { location: "/next" }, "") // relative
      : rawResponse(200, { "content-length": "4" }, "done")
  );
  const fetch = makeSafeFetch({ resolver: () => Promise.resolve(["93.184.216.34"]), transport });
  const res = await fetch("https://a.example/deep/start");
  assertEquals(await res.text(), "done");
  assertStringIncludes(
    requests[1],
    "GET /next HTTP/1.1\r\n",
    "relative Location resolved to /next",
  );
  assertStringIncludes(requests[1], "Host: a.example\r\n", "same host preserved");
});

Deno.test("pinnedFetch prefers the IPv4 address when both families resolve", async () => {
  const resolver: Resolver = () => Promise.resolve(["2606:4700:4700::1111", "93.184.216.34"]);
  const { transport, calls } = recordingTransport(rawResponse(200, { "content-length": "1" }, "x"));
  await makePinnedFetch({ resolver, transport })(new URL("https://example.com/a"), {});
  assertEquals(calls[0].ip, "93.184.216.34", "the IPv4 record is pinned, not the IPv6");
});

// M1: the abort/timeout signal must cover the TCP connect handshake. `connectWithAbort`
// races a pending connect against the signal — a blackholed host that never completes
// the handshake rejects promptly instead of hanging until the OS connect timeout.
Deno.test("M1: connectWithAbort rejects on abort during a hung connect, and closes a late socket", async () => {
  // A connect that never resolves on its own (the blackholed-host case).
  let resolveConnect: (c: { close(): void }) => void = () => {};
  const connecting = new Promise<{ close(): void }>((r) => (resolveConnect = r));

  const ac = new AbortController();
  const raced = connectWithAbort(connecting, ac.signal);

  // Abort mid-handshake → the race rejects with "aborted", not after any OS timeout.
  ac.abort();
  await assertRejects(() => raced, Error, "aborted");

  // If the underlying connect *later* succeeds, its socket must be closed (no leak).
  let closed = false;
  resolveConnect({ close: () => (closed = true) });
  await Promise.resolve();
  await Promise.resolve();
  assert(closed, "a socket that lands after the abort is closed");
});

Deno.test("M1: connectWithAbort short-circuits when the signal is already aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  let closed = false;
  const connecting = Promise.resolve({ close: () => (closed = true) });
  await assertRejects(() => connectWithAbort(connecting, ac.signal), Error, "aborted");
  await Promise.resolve();
  await Promise.resolve();
  assert(closed, "the already-resolved socket is still closed on a pre-aborted signal");
});

Deno.test("M1: connectWithAbort resolves normally when connect wins the race", async () => {
  const ac = new AbortController();
  const conn = { close: () => {} };
  const out = await connectWithAbort(Promise.resolve(conn), ac.signal);
  assertEquals(out, conn);
});
