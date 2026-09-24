// denext/mobile over-the-air UI client (src/mobile/ota.ts): checkForUiUpdate,
// prepareUiUpdate, applyUiUpdate, otaBooted, otaStatus and otaReset against a stubbed `window.Capacitor` (as mobile-runtime.test.ts
// does) and an injected `fetch`. checkForUiUpdate must never throw: every failure is a value.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  applyUiUpdate,
  checkForUiUpdate,
  otaBooted,
  type OtaCheckResult,
  type OtaPrepareResult,
  otaReset,
  otaStatus,
  prepareUiUpdate,
} from "../src/mobile/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

const SERVER = "a".repeat(64);
const BUNDLED = "b".repeat(64);
const MANIFEST = {
  version: SERVER,
  files: [{ path: "index.html", sha256: "c".repeat(64), size: 13 }],
};

interface Calls {
  status: number;
  apply: Any[];
  download: Any[];
  activate: Any[];
  booted: number;
  reset: number;
}

/**
 * A DenextOta plugin stub reporting `status`, whose `apply` and `download` run `applyImpl`
 * and whose `activate` runs `activateImpl`.
 */
function plugin(
  status: Record<string, string | null>,
  applyImpl: () => Promise<unknown> = () => Promise.resolve({}),
  activateImpl: () => Promise<unknown> = () => Promise.resolve({}),
): { plugin: Any; calls: Calls } {
  const calls: Calls = { status: 0, apply: [], download: [], activate: [], booted: 0, reset: 0 };
  return {
    calls,
    plugin: {
      status: () => (calls.status++, Promise.resolve(status)),
      apply: (options: Any) => (calls.apply.push(options), applyImpl()),
      download: (options: Any) => (calls.download.push(options), applyImpl()),
      activate: (options: Any) => (calls.activate.push(options), activateImpl()),
      booted: () => (calls.booted++, Promise.resolve()),
      reset: () => (calls.reset++, Promise.resolve()),
    },
  };
}

/** Run `fn` with `window.Capacitor` stubbed (native iOS unless `native` is false). */
async function withShell(
  plugins: Record<string, unknown>,
  fn: () => Promise<void>,
  native = true,
): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(g, "Capacitor");
  g.Capacitor = { isNativePlatform: () => native, getPlatform: () => "ios", Plugins: plugins };
  try {
    await fn();
  } finally {
    if (saved) Object.defineProperty(g, "Capacitor", saved);
    else delete g.Capacitor;
  }
}

/** A `fetch` stub recording its calls and answering with `respond`. */
function fakeFetch(respond: (init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = ((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond(init));
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const okManifest = () => fakeFetch(() => Response.json(MANIFEST));
const BASE = "https://ui.example.com/mobile/";

Deno.test("checkForUiUpdate: the running version is current → no apply", async () => {
  const { plugin: p, calls } = plugin({ current: null, bundled: SERVER, pending: null });
  await withShell({ DenextOta: p }, async () => {
    const f = okManifest();
    assertEquals(await checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch }), { kind: "current" });
    assertEquals(calls.apply.length, 0);
  });
});

Deno.test("checkForUiUpdate: a confirmed download wins over the bundled version", async () => {
  const { plugin: p, calls } = plugin({ current: SERVER, bundled: BUNDLED, pending: null });
  await withShell({ DenextOta: p }, async () => {
    const r = await checkForUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
    assertEquals(r, { kind: "current" });
    assertEquals(calls.apply.length, 0);
  });
});

Deno.test("checkForUiUpdate: a different version → apply with baseUrl, headers, manifest", async () => {
  const { plugin: p, calls } = plugin({ current: null, bundled: BUNDLED, pending: null });
  await withShell({ DenextOta: p }, async () => {
    const f = okManifest();
    const headers = { authorization: "Bearer secret" };
    const r = await checkForUiUpdate({ baseUrl: BASE, headers, fetch: f.fetch });
    assertEquals(r, { kind: "applied", version: SERVER });
    assertEquals(f.calls.length, 1);
    assertEquals(f.calls[0].url, "https://ui.example.com/mobile/_denext/ota.json");
    assertEquals(f.calls[0].init.headers, headers);
    assertEquals(f.calls[0].init.cache, "no-store");
    assert(f.calls[0].init.signal instanceof AbortSignal);
    assertEquals(calls.apply, [{
      baseUrl: "https://ui.example.com/mobile",
      headers,
      manifest: MANIFEST,
    }]);
    // The auto path is one native apply: it never stages, so it never needs activate.
    assertEquals(calls.download.length, 0);
    assertEquals(calls.activate.length, 0);
  });
});

Deno.test("checkForUiUpdate: a shell without download/activate still applies", async () => {
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  delete p.download;
  delete p.activate;
  await withShell({ DenextOta: p }, async () => {
    const r = await checkForUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
    assertEquals(r, { kind: "applied", version: SERVER });
    assertEquals(calls.apply.length, 1);
  });
});

Deno.test("checkForUiUpdate: not native → unsupported, no network", async () => {
  const { plugin: p } = plugin({ bundled: BUNDLED });
  const f = okManifest();
  // No Capacitor global at all (SSR / plain web).
  assertEquals(await checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch }), {
    kind: "unsupported",
  });
  // @capacitor/core bundled into a web build: isNativePlatform() is false.
  await withShell({ DenextOta: p }, async () => {
    assertEquals((await checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch })).kind, "unsupported");
  }, false);
  assertEquals(f.calls.length, 0);
});

Deno.test("checkForUiUpdate: the shell has no DenextOta plugin → unsupported", async () => {
  const f = okManifest();
  await withShell({}, async () => {
    assertEquals((await checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch })).kind, "unsupported");
  });
  // A plugin missing a method (an older shell) counts as missing too.
  await withShell({ DenextOta: { status: () => Promise.resolve({}) } }, async () => {
    assertEquals((await checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch })).kind, "unsupported");
  });
  assertEquals(f.calls.length, 0);
});

/** Assert `r` is an error whose reason mentions `needle`, and nothing was applied. */
function assertError(r: OtaCheckResult, needle: string, calls: Calls): void {
  assertEquals(r.kind, "error");
  assert(r.kind === "error" && r.reason.includes(needle), JSON.stringify(r));
  assertEquals(calls.apply.length, 0);
}

Deno.test("checkForUiUpdate: network error → error, never throws", async () => {
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError("Load failed")));
    assertError(await checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch }), "Load failed", calls);
  });
});

Deno.test("checkForUiUpdate: HTTP error, bad JSON and a malformed manifest → error", async () => {
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    const http = fakeFetch(() => new Response("nope", { status: 404 }));
    assertError(await checkForUiUpdate({ baseUrl: BASE, fetch: http.fetch }), "HTTP 404", calls);
    const json = fakeFetch(() => new Response("{not json"));
    assertError(await checkForUiUpdate({ baseUrl: BASE, fetch: json.fetch }), "JSON", calls);
    const shape = fakeFetch(() => Response.json({ version: "not-hex", files: [] }));
    assertError(await checkForUiUpdate({ baseUrl: BASE, fetch: shape.fetch }), "malformed", calls);
    assertEquals(calls.status, 0, "status is only asked once a manifest validates");
  });
});

Deno.test("checkForUiUpdate: a manifest request that outlives timeoutMs → error", async () => {
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    // Never answers; rejects only when the caller's signal aborts, as fetch does.
    const f = fakeFetch((init) =>
      new Promise<Response>((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })
    );
    const r = await checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch, timeoutMs: 20 });
    assertError(r, "timed out after 20 ms", calls);
  });
});

Deno.test("checkForUiUpdate: native rejected/busy → skipped; other rejections → error", async () => {
  const reject = (code: string) => () =>
    Promise.reject(Object.assign(new Error(`nope (${code})`), { code }));
  for (const code of ["rejected", "busy"] as const) {
    const { plugin: p } = plugin({ bundled: BUNDLED }, reject(code));
    await withShell({ DenextOta: p }, async () => {
      const r = await checkForUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
      assertEquals(r, { kind: "skipped", reason: code });
    });
  }
  const { plugin: p } = plugin({ bundled: BUNDLED }, reject("integrity"));
  await withShell({ DenextOta: p }, async () => {
    const r = await checkForUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
    assertEquals(r, { kind: "error", reason: "nope (integrity)", code: "integrity" });
  });
  // A failing status() is an error too, not a throw.
  const broken = plugin({}).plugin;
  broken.status = () => Promise.reject(new Error("bridge gone"));
  await withShell({ DenextOta: broken }, async () => {
    const r = await checkForUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
    assertEquals(r.kind, "error");
  });
});

Deno.test("checkForUiUpdate: concurrent calls share the in-flight check", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { plugin: p, calls } = plugin({ bundled: BUNDLED }, () => gate);
  await withShell({ DenextOta: p }, async () => {
    const f = okManifest();
    const first = checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch });
    const second = checkForUiUpdate({ baseUrl: "https://other.example.com", fetch: f.fetch });
    assert(first === second, "the second call gets the in-flight promise");
    release();
    assertEquals(await first, { kind: "applied", version: SERVER });
    assertEquals(f.calls.length, 1);
    assertEquals(calls.apply.length, 1);
    // Once settled, the next call runs a fresh check.
    const third = checkForUiUpdate({ baseUrl: BASE, fetch: f.fetch });
    assert(third !== first);
    await third;
    assertEquals(f.calls.length, 2);
  });
});

Deno.test("otaBooted / otaStatus / otaReset: native calls, no-ops on the web", async () => {
  // Web: nothing to call, nothing thrown.
  await otaBooted();
  await otaReset();
  assertEquals(await otaStatus(), null);

  const { plugin: p, calls } = plugin({ current: SERVER, bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    await otaBooted();
    assertEquals(calls.booted, 1);
    assertEquals(await otaStatus(), {
      current: SERVER,
      bundled: BUNDLED,
      pending: null,
      rejected: null,
      staged: null,
    });
    await otaReset();
    assertEquals(calls.reset, 1);
  });

  // otaBooted swallows a native failure; otaReset surfaces it.
  const failing = plugin({}).plugin;
  failing.booted = () => Promise.reject(new Error("boom"));
  failing.reset = () => Promise.reject(Object.assign(new Error("busy"), { code: "busy" }));
  await withShell({ DenextOta: failing }, async () => {
    await otaBooted();
    await assertRejects(() => otaReset(), Error, "busy");
  });
});

// ---- prepareUiUpdate / applyUiUpdate: the staged path for an app's own update prompt ----

Deno.test("prepareUiUpdate: a different version → download (not apply), ready with defaults", async () => {
  const { plugin: p, calls } = plugin({ current: null, bundled: BUNDLED, pending: null });
  await withShell({ DenextOta: p }, async () => {
    const f = okManifest();
    const headers = { authorization: "Bearer secret" };
    const r = await prepareUiUpdate({ baseUrl: BASE, headers, fetch: f.fetch });
    assertEquals(r, { kind: "ready", version: SERVER, required: false, notes: null });
    assertEquals(f.calls[0].url, "https://ui.example.com/mobile/_denext/ota.json");
    assertEquals(f.calls[0].init.cache, "no-store");
    assertEquals(calls.download, [{
      baseUrl: "https://ui.example.com/mobile",
      headers,
      manifest: MANIFEST,
    }]);
    assertEquals(calls.apply.length, 0, "prepare never switches");
    assertEquals(calls.activate.length, 0, "prepare never switches");
  });
});

Deno.test("prepareUiUpdate: required and notes come from the manifest", async () => {
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    const manifest = { ...MANIFEST, required: true, notes: "Fixes sign-in" };
    const f = fakeFetch(() => Response.json(manifest));
    const r = await prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch });
    assertEquals(r, { kind: "ready", version: SERVER, required: true, notes: "Fixes sign-in" });
    // The native side gets the manifest as served; it ignores the metadata.
    assertEquals(calls.download[0].manifest, manifest);
  });
});

Deno.test("prepareUiUpdate: malformed metadata fails validation → error, no download", async () => {
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    for (const bad of [{ required: "yes" }, { notes: 42 }, { notes: "x".repeat(2001) }]) {
      const f = fakeFetch(() => Response.json({ ...MANIFEST, ...bad }));
      const r = await prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch });
      assert(r.kind === "error" && r.reason.includes("malformed"), JSON.stringify(r));
    }
    assertEquals(calls.download.length, 0);
  });
});

Deno.test("prepareUiUpdate: the running version is current → no download", async () => {
  for (
    const status of [{ current: null, bundled: SERVER }, { current: SERVER, bundled: BUNDLED }]
  ) {
    const { plugin: p, calls } = plugin(status);
    await withShell({ DenextOta: p }, async () => {
      const r = await prepareUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
      assertEquals(r, { kind: "current" });
      assertEquals(calls.download.length, 0);
    });
  }
});

Deno.test("prepareUiUpdate: not native, no plugin, or a plugin without download → unsupported", async () => {
  const f = okManifest();
  assertEquals(await prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch }), { kind: "unsupported" });
  const { plugin: web } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: web }, async () => {
    assertEquals((await prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch })).kind, "unsupported");
  }, false);
  await withShell({}, async () => {
    assertEquals((await prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch })).kind, "unsupported");
  });
  // A shell installed before staged updates: apply works, prepare reports unsupported.
  const { plugin: old } = plugin({ bundled: BUNDLED });
  delete old.download;
  delete old.activate;
  await withShell({ DenextOta: old }, async () => {
    assertEquals((await prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch })).kind, "unsupported");
  });
  assertEquals(f.calls.length, 0);
});

Deno.test("prepareUiUpdate: native rejected/busy → skipped; other failures → error", async () => {
  const reject = (code: string) => () =>
    Promise.reject(Object.assign(new Error(`nope (${code})`), { code }));
  for (const code of ["rejected", "busy"] as const) {
    const { plugin: p } = plugin({ bundled: BUNDLED }, reject(code));
    await withShell({ DenextOta: p }, async () => {
      const r = await prepareUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
      assertEquals(r, { kind: "skipped", reason: code });
    });
  }
  const { plugin: p, calls } = plugin({ bundled: BUNDLED }, reject("integrity"));
  await withShell({ DenextOta: p }, async () => {
    const r = await prepareUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
    assertEquals(r, { kind: "error", reason: "nope (integrity)", code: "integrity" });
    const http = fakeFetch(() => new Response("nope", { status: 503 }));
    const e: OtaPrepareResult = await prepareUiUpdate({ baseUrl: BASE, fetch: http.fetch });
    assert(e.kind === "error" && e.reason.includes("HTTP 503"), JSON.stringify(e));
    assertEquals(calls.download.length, 1);
  });
  const broken = plugin({}).plugin;
  broken.status = () => Promise.reject(new Error("bridge gone"));
  await withShell({ DenextOta: broken }, async () => {
    const r = await prepareUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
    assert(r.kind === "error" && r.reason.includes("bridge gone"), JSON.stringify(r));
  });
});

Deno.test("prepareUiUpdate: concurrent calls share the in-flight prepare", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { plugin: p, calls } = plugin({ bundled: BUNDLED }, () => gate);
  await withShell({ DenextOta: p }, async () => {
    const f = okManifest();
    const first = prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch });
    const second = prepareUiUpdate({ baseUrl: "https://other.example.com", fetch: f.fetch });
    assert(first === second, "the second call gets the in-flight promise");
    release();
    assertEquals((await first).kind, "ready");
    assertEquals(f.calls.length, 1);
    assertEquals(calls.download.length, 1);
    const third = prepareUiUpdate({ baseUrl: BASE, fetch: f.fetch });
    assert(third !== first);
    await third;
    assertEquals(f.calls.length, 2);
  });
});

/** Whether `promise` has settled after the event loop has had a turn. */
async function settled<T>(promise: Promise<T>): Promise<{ value: T } | "pending"> {
  await new Promise((r) => setTimeout(r, 10));
  return await Promise.race([
    promise.then((value) => ({ value })),
    Promise.resolve("pending" as const),
  ]);
}

Deno.test("applyUiUpdate: activates the staged version and then never settles (the page reloads)", async () => {
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    const pending = applyUiUpdate(SERVER);
    assertEquals(await settled(pending), "pending");
    assertEquals(calls.activate, [{ version: SERVER }]);
    assertEquals(calls.apply.length, 0);
  });
});

Deno.test("applyUiUpdate: unsupported off native or on an older plugin; native refusal → error", async () => {
  assertEquals(await applyUiUpdate(SERVER), { kind: "unsupported" });
  const { plugin: old } = plugin({ bundled: BUNDLED });
  delete old.activate;
  await withShell({ DenextOta: old }, async () => {
    assertEquals(await applyUiUpdate(SERVER), { kind: "unsupported" });
  });
  const { plugin: p, calls } = plugin(
    { bundled: BUNDLED },
    undefined,
    () => Promise.reject(Object.assign(new Error("UI x is not staged"), { code: "not_staged" })),
  );
  await withShell({ DenextOta: p }, async () => {
    assertEquals(await applyUiUpdate(SERVER), {
      kind: "error",
      reason: "UI x is not staged",
      code: "not_staged",
    });
    assertEquals(calls.activate, [{ version: SERVER }]);
  });
});

Deno.test("otaStatus: reports the staged version", async () => {
  const { plugin: p } = plugin({ bundled: BUNDLED, staged: SERVER });
  await withShell({ DenextOta: p }, async () => {
    assertEquals((await otaStatus())?.staged, SERVER);
  });
});

Deno.test("signed OTA: the manifest's signature crosses the bridge on apply and download", async () => {
  const signed = { ...MANIFEST, required: true, notes: "n", signature: "c2ln".repeat(22) };
  const f = () => fakeFetch(() => Response.json(signed));
  const { plugin: p, calls } = plugin({ bundled: BUNDLED });
  await withShell({ DenextOta: p }, async () => {
    assertEquals((await checkForUiUpdate({ baseUrl: BASE, fetch: f().fetch })).kind, "applied");
    assertEquals(calls.apply[0].manifest, signed);
    assertEquals((await prepareUiUpdate({ baseUrl: BASE, fetch: f().fetch })).kind, "ready");
    assertEquals(calls.download[0].manifest.signature, signed.signature);
  });
});

Deno.test("signed OTA: native signature/insecure refusals are errors carrying their code", async () => {
  const reject = (code: string) => () =>
    Promise.reject(Object.assign(new Error(`refused (${code})`), { code }));
  for (const code of ["signature", "insecure"] as const) {
    const { plugin: p } = plugin({ bundled: BUNDLED }, reject(code));
    await withShell({ DenextOta: p }, async () => {
      const expected = { kind: "error" as const, reason: `refused (${code})`, code };
      assertEquals(await checkForUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch }), expected);
      assertEquals(await prepareUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch }), expected);
    });
  }
  // An unknown native code is not claimed as one of ours.
  const { plugin: p } = plugin({ bundled: BUNDLED }, reject("mystery"));
  await withShell({ DenextOta: p }, async () => {
    const r = await checkForUiUpdate({ baseUrl: BASE, fetch: okManifest().fetch });
    assertEquals(r, { kind: "error", reason: "refused (mystery)" });
  });
});
