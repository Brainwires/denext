// Coverage for small server-side helpers that are directly unit-testable:
// abort.ts (isAbortError / raceAbort), env.ts (parseEnv / loadEnv / publicEnvFrom),
// and request-context.ts (context creation, cookies/headers, draftMode, after,
// connection, resource hints, searchParam-read tracking).

import { assert, assertEquals } from "@std/assert";
import { isAbortError, raceAbort } from "../src/server/abort.ts";
import { loadEnv, parseEnv, publicEnvFrom } from "../src/server/env.ts";
import {
  addResourceHint,
  after,
  clientIp,
  connection,
  cookies,
  createRequestContext,
  currentContext,
  draftMode,
  headers,
  type RequestContext,
  requestId,
  requestSignal,
  runDeferred,
  runWithContext,
  setDraftTokenStore,
  trackSearchParamReads,
  warnUnkeyedParamReads,
} from "../src/server/request-context.ts";
import { setRemoteAddr } from "../src/server/remote-addr.ts";
import { unstable_cache, withCacheScope } from "../src/server/cache.ts";

// ---- abort.ts --------------------------------------------------------------

Deno.test("isAbortError recognizes a DOMException AbortError", () => {
  assert(isAbortError(new DOMException("aborted", "AbortError")));
  assert(!isAbortError(new DOMException("boom", "InvalidStateError")));
});

Deno.test("isAbortError recognizes a plain object with name AbortError, else false", () => {
  assert(isAbortError({ name: "AbortError" }));
  assert(!isAbortError(new Error("regular")));
  assert(!isAbortError(null));
  assert(!isAbortError(undefined));
});

Deno.test("raceAbort with no signal returns the underlying promise", async () => {
  assertEquals(await raceAbort(Promise.resolve("value")), "value");
});

Deno.test("raceAbort with an already-aborted signal resolves to undefined without waiting", async () => {
  const ac = new AbortController();
  ac.abort();
  const never = new Promise<string>(() => {}); // never settles
  assertEquals(await raceAbort(never, ac.signal), undefined);
});

Deno.test("raceAbort resolves with the value when the promise wins", async () => {
  const ac = new AbortController();
  assertEquals(await raceAbort(Promise.resolve(7), ac.signal), 7);
});

Deno.test("raceAbort resolves early (undefined) when the signal aborts mid-flight", async () => {
  const ac = new AbortController();
  const slow = new Promise<string>((r) => setTimeout(() => r("late"), 10_000));
  queueMicrotask(() => ac.abort());
  assertEquals(await raceAbort(slow, ac.signal), undefined);
});

// ---- env.ts ----------------------------------------------------------------

Deno.test("parseEnv handles export, comments, quotes, escapes and inline comments", () => {
  const parsed = parseEnv(
    [
      "# a comment",
      "",
      "export FOO=bar",
      "PLAIN=value # trailing comment",
      'DQ="line\\nbreak\\ttab"',
      "SQ='raw\\nnoescape'",
      "=novalue",
      "123BAD=nope",
      "SPACED =  spaced value  ",
      'EMPTY=""',
    ].join("\n"),
  );
  assertEquals(parsed.FOO, "bar");
  assertEquals(parsed.PLAIN, "value");
  assertEquals(parsed.DQ, "line\nbreak\ttab");
  assertEquals(parsed.SQ, "raw\\nnoescape"); // single quotes do not interpret escapes
  assertEquals(parsed.SPACED, "spaced value");
  assertEquals(parsed.EMPTY, "");
  assert(!("123BAD" in parsed), "an invalid env name is skipped");
  assert(!("" in parsed), "a keyless line is skipped");
});

Deno.test("loadEnv reads files with later files winning, honoring override", async () => {
  const dir = await Deno.makeTempDir();
  const key = `DENEXT_TEST_ENV_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await Deno.writeTextFile(`${dir}/.env`, `${key}=base\nONLY_BASE=1`);
    await Deno.writeTextFile(`${dir}/.env.local`, `${key}=local`);
    // Pre-seed the process env; without override the existing value wins.
    Deno.env.set(key, "shell");
    const merged = await loadEnv({ dir });
    assertEquals(merged[key], "local", "later file overrides earlier in the merged record");
    assertEquals(merged.ONLY_BASE, "1");
    assertEquals(Deno.env.get(key), "shell", "existing env is not clobbered by default");

    // With override, the file value wins over the existing env.
    await loadEnv({ dir, override: true });
    assertEquals(Deno.env.get(key), "local");
  } finally {
    Deno.env.delete(key);
    Deno.env.delete("ONLY_BASE");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadEnv ignores a missing directory (no throw)", async () => {
  const merged = await loadEnv({ dir: `/no/such/dir/${crypto.randomUUID()}` });
  assertEquals(merged, {});
});

Deno.test("publicEnvFrom filters to the public subset", () => {
  const pub = publicEnvFrom({ NEXT_PUBLIC_X: "1", SECRET: "2", DENEXT_PUBLIC_Y: "3" });
  assertEquals(pub.NEXT_PUBLIC_X, "1");
  assert(!("SECRET" in pub), "a non-public key is dropped");
});

// ---- request-context.ts ----------------------------------------------------

function ctxFor(url: string, headersInit?: HeadersInit, signal?: AbortSignal): RequestContext {
  return createRequestContext(new Request(url, { headers: headersInit }), signal);
}

Deno.test("createRequestContext mints a UUID request id when none is inbound", () => {
  const ctx = ctxFor("http://localhost/");
  assert(/^[0-9a-f-]{36}$/.test(ctx.requestId));
  assert(ctx.outgoingHeaders instanceof Headers);
  assertEquals(ctx.deferred.length, 0);
});

Deno.test("createRequestContext sanitizes and reuses a trusted proxy's inbound x-request-id", () => {
  // A valid header value carrying spaces (outside \x21-\x7E) — those are stripped.
  const ctx = createRequestContext(
    new Request("http://localhost/", { headers: { "x-request-id": "abc 123 def" } }),
    undefined,
    { trustForwardedHeaders: true },
  );
  assertEquals(ctx.requestId, "abc123def");
});

Deno.test("createRequestContext falls back to a UUID when the inbound id sanitizes to empty", () => {
  const ctx = ctxFor("http://localhost/", { "x-request-id": "   " });
  assert(/^[0-9a-f-]{36}$/.test(ctx.requestId));
});

Deno.test("headers() returns the request headers and marks the render dynamic", () => {
  const ctx = ctxFor("http://localhost/", { "x-test": "yes" });
  runWithContext(ctx, () => {
    assertEquals(headers().get("x-test"), "yes");
  });
  assert(ctx.usedDynamicApi);
});

Deno.test("cookies() reads incoming and queues secure-by-default Set-Cookie over https", () => {
  const ctx = ctxFor("https://example.com/", { cookie: "sid=1; theme=dark" });
  runWithContext(ctx, () => {
    const store = cookies();
    assertEquals(store.get("sid"), { name: "sid", value: "1" });
    assert(store.has("theme"));
    assertEquals(store.getAll().find((c) => c.name === "theme")?.value, "dark");
    store.set("token", "abc");
  });
  const setCookie = ctx.outgoingHeaders.getSetCookie().join("\n");
  assert(setCookie.includes("token=abc"));
  assert(/HttpOnly/i.test(setCookie), "httpOnly by default");
  assert(/Secure/i.test(setCookie), "Secure over https");
  assert(/SameSite=Lax/i.test(setCookie));
});

Deno.test("cookies() honors x-forwarded-proto=https and httpOnly:false opt-out", () => {
  const ctx = ctxFor("http://example.com/", { "x-forwarded-proto": "https" });
  runWithContext(ctx, () => {
    cookies().set("readable", "v", { httpOnly: false });
  });
  const sc = ctx.outgoingHeaders.getSetCookie().join("\n");
  assert(/Secure/i.test(sc), "Secure inferred from x-forwarded-proto");
  assert(!/HttpOnly/i.test(sc), "httpOnly opted out");
});

Deno.test("cookies().delete queues a deletion", () => {
  const ctx = ctxFor("http://example.com/");
  runWithContext(ctx, () => {
    cookies().delete("sid");
  });
  const sc = ctx.outgoingHeaders.getSetCookie().join("\n");
  assert(sc.includes("sid="));
});

Deno.test("draftMode enable mints a token, isEnabled reflects the store, disable clears it", () => {
  // Fresh in-memory store so this test is isolated.
  const tokens = new Set<string>();
  setDraftTokenStore({
    has: (t) => tokens.has(t),
    add: (t) => void tokens.add(t),
    delete: (t) => void tokens.delete(t),
  });
  try {
    const ctx = ctxFor("http://localhost/");
    runWithContext(ctx, () => {
      const dm = draftMode();
      assert(!dm.isEnabled, "off with no cookie");
      dm.enable();
    });
    assertEquals(tokens.size, 1, "enable minted a token into the store");
    const token = [...tokens][0];
    // A request carrying that cookie reads as enabled.
    const ctx2 = ctxFor("http://localhost/", { cookie: `__denext_draft=${token}` });
    runWithContext(ctx2, () => {
      assert(draftMode().isEnabled, "enabled when the cookie matches a stored token");
      draftMode().disable();
    });
    assertEquals(tokens.size, 0, "disable invalidated the token");
  } finally {
    // Restore a default store for other tests in the process.
    setDraftTokenStore({
      has: () => false,
      add: () => {},
      delete: () => {},
    });
  }
});

Deno.test("draftMode is off for a forged cookie value not in the store", () => {
  setDraftTokenStore({ has: () => false, add: () => {}, delete: () => {} });
  const ctx = ctxFor("http://localhost/", { cookie: "__denext_draft=forged" });
  runWithContext(ctx, () => {
    assert(!draftMode().isEnabled);
  });
});

Deno.test("after() defers inside a request and runs immediately outside one", async () => {
  const order: string[] = [];
  // Outside a request: runs synchronously (immediately).
  after(() => order.push("immediate"));
  assertEquals(order, ["immediate"]);

  const ctx = ctxFor("http://localhost/");
  runWithContext(ctx, () => {
    after(() => order.push("deferred"));
  });
  assertEquals(ctx.deferred.length, 1, "queued, not yet run");
  await runDeferred(ctx);
  assertEquals(order, ["immediate", "deferred"]);
  assertEquals(ctx.deferred.length, 0, "drained");
});

Deno.test("runDeferred swallows a throwing callback", async () => {
  const ctx = ctxFor("http://localhost/");
  let ran = false;
  ctx.deferred.push(() => {
    throw new Error("after boom");
  });
  ctx.deferred.push(() => {
    ran = true;
  });
  await runDeferred(ctx); // must not reject
  assert(ran, "a later callback still runs after an earlier one throws");
});

Deno.test("connection() resolves and marks the render dynamic", async () => {
  const ctx = ctxFor("http://localhost/");
  await runWithContext(ctx, () => connection());
  assert(ctx.usedDynamicApi);
});

/** A request whose socket peer the server loop would have recorded. */
function ctxWithPeer(peer: string | null, headersInit?: HeadersInit): RequestContext {
  const req = new Request("http://localhost/", { headers: headersInit });
  if (peer !== null) setRemoteAddr(req, { transport: "tcp", hostname: peer, port: 1 });
  return createRequestContext(req);
}

Deno.test("clientIp() returns the socket peer and marks the render dynamic", () => {
  const ctx = ctxWithPeer("203.0.113.7");
  const ip = runWithContext(ctx, () => clientIp());
  assertEquals(ip, "203.0.113.7");
  assert(ctx.usedDynamicApi, "reading the client IP is a dynamic read");
});

Deno.test("clientIp() ignores x-forwarded-for unless the app trusts the proxy", () => {
  const untrusted = ctxWithPeer("203.0.113.7", { "x-forwarded-for": "1.2.3.4, 9.9.9.9" });
  assertEquals(runWithContext(untrusted, () => clientIp()), "203.0.113.7");

  const trusted = ctxWithPeer("10.0.0.1", { "x-forwarded-for": "1.2.3.4, 9.9.9.9" });
  trusted.trustForwardedHeaders = true;
  // The last hop is the address the trusted proxy saw; earlier hops are client-supplied.
  assertEquals(runWithContext(trusted, () => clientIp()), "9.9.9.9");
});

Deno.test("clientIp() is undefined outside denext's server loop, and requires a request", () => {
  const noPeer = ctxWithPeer(null); // a handler called directly, no socket peer recorded
  assertEquals(runWithContext(noPeer, () => clientIp()), undefined);
  let threw = false;
  try {
    clientIp();
  } catch {
    threw = true;
  }
  assert(threw, "clientIp() outside a request throws");
});

Deno.test("requestId() returns the id and does NOT mark the render dynamic", () => {
  const ctx = createRequestContext(
    new Request("http://localhost/", { headers: { "x-request-id": "trace-123" } }),
    undefined,
    { trustForwardedHeaders: true },
  );
  const id = runWithContext(ctx, () => requestId());
  assertEquals(id, "trace-123");
  assert(!ctx.usedDynamicApi, "the request id is plumbing, not a dynamic read");
});

Deno.test("requestId() ignores an inbound x-request-id unless the proxy is trusted", () => {
  const ctx = ctxFor("http://localhost/", { "x-request-id": "client-picked" });
  const id = runWithContext(ctx, () => requestId());
  assert(id !== "client-picked", "a client can't choose its own correlation id");
  assert(/^[0-9a-f-]{36}$/.test(id), "a fresh UUID is minted");
  // trustRequestId overrides the default (internal sub-requests derive their own id).
  const sub = createRequestContext(
    new Request("http://localhost/", { headers: { "x-request-id": "parent#1" } }),
    undefined,
    { trustForwardedHeaders: false, trustRequestId: true },
  );
  assertEquals(sub.requestId, "parent#1");
  assertEquals(sub.trustForwardedHeaders, false);
});

Deno.test("requestSignal() returns the context signal, undefined outside a request", () => {
  const controller = new AbortController();
  const ctx = ctxFor("http://localhost/", undefined, controller.signal);
  assertEquals(runWithContext(ctx, () => requestSignal()), controller.signal);
  assertEquals(requestSignal(), undefined);
  assert(!ctx.usedDynamicApi, "threading the abort signal does not make the render dynamic");
});

Deno.test("requestSignal() is undefined inside a use-cache scope (shared fills never inherit one request's abort)", async () => {
  const controller = new AbortController();
  const ctx = ctxFor("http://localhost/", undefined, controller.signal);
  const seen: (AbortSignal | undefined)[] = [];
  await runWithContext(ctx, () =>
    withCacheScope(() => {
      seen.push(requestSignal());
      return 1;
    }));
  assertEquals(seen, [undefined]);
  // Outside the scope, in the same request, the signal is still there.
  assertEquals(runWithContext(ctx, () => requestSignal()), controller.signal);
});

Deno.test("requestSignal(): the leader's client disconnect does not abort a single-flight fill a follower awaits", async () => {
  const leaderCtl = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const load = unstable_cache(async () => {
    const signal = requestSignal(); // what a loader would thread into its fetch()
    await gate;
    signal?.throwIfAborted();
    return "filled";
  }, ["request-signal-single-flight"]);
  const leader = runWithContext(
    ctxFor("http://localhost/", undefined, leaderCtl.signal),
    () => load(),
  );
  const follower = runWithContext(ctxFor("http://localhost/"), () => load());
  leaderCtl.abort(); // the leader's client navigates away mid-fill
  release();
  assertEquals(await follower, "filled", "the follower is not failed by another request's abort");
  assertEquals(await leader, "filled");
});

Deno.test("addResourceHint records + dedupes inside a request, no-op outside", () => {
  assert(!addResourceHint("<link rel=preload>"), "false with no active request");
  const ctx = ctxFor("http://localhost/");
  runWithContext(ctx, () => {
    assert(addResourceHint("<link rel=preload href=a>"));
    assert(addResourceHint("<link rel=preload href=a>"), "still returns true on a duplicate");
  });
  assertEquals(ctx.resourceHints, ["<link rel=preload href=a>"]);
});

Deno.test("currentContext returns the active context and undefined outside", () => {
  assertEquals(currentContext(), undefined);
  const ctx = ctxFor("http://localhost/");
  runWithContext(ctx, () => {
    assertEquals(currentContext(), ctx);
  });
});

Deno.test("trackSearchParamReads is a passthrough when tracking is off", () => {
  const ctx = ctxFor("http://localhost/");
  runWithContext(ctx, () => {
    const sp = new URLSearchParams("a=1&b=2");
    assertEquals(trackSearchParamReads(sp), sp, "untouched object when trackParamReads is off");
  });
});

Deno.test("trackSearchParamReads records name-specific and whole-collection reads", () => {
  const ctx = ctxFor("http://localhost/");
  ctx.trackParamReads = true;
  runWithContext(ctx, () => {
    const sp = trackSearchParamReads(new URLSearchParams("a=1&b=2&c=3"));
    sp.get("a");
    sp.has("b");
    assertEquals(ctx.paramReads && [...ctx.paramReads].sort(), ["a", "b"]);
    // A whole-collection read records every present name.
    [...sp.keys()];
    assertEquals(ctx.paramReads && [...ctx.paramReads].sort(), ["a", "b", "c"]);
  });
});

Deno.test("warnUnkeyedParamReads returns true only for a non-allowlisted read", () => {
  const base = ctxFor("http://localhost/");
  assert(!warnUnkeyedParamReads(base, ["a"]), "no reads → safe to cache");

  const leaked = ctxFor("http://localhost/");
  leaked.paramReads = new Set(["a", "b"]);
  assert(warnUnkeyedParamReads(leaked, ["a"]), "b is outside the allowlist → leak");

  const clean = ctxFor("http://localhost/");
  clean.paramReads = new Set(["a"]);
  assert(!warnUnkeyedParamReads(clean, ["a", "b"]), "all reads allowlisted → safe");
});
