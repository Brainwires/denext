// `denext/updates` (page side): checkForUpdates / applyUpdates on each platform, over fakes —
// a stubbed `window.Capacitor` with the DenextOta plugin (iOS), the fake desktop bridge with an
// `updates` capability that pushes progress events (Deno Desktop), and an injected `fetch` +
// `reload` (a browser tab). One progress shape everywhere; nothing throws.

import { assert, assertEquals } from "@std/assert";
import {
  applyUpdates,
  checkForUpdates,
  type UpdateProgress,
  type UpdatesConfig,
} from "../src/updates/mod.ts";
import { resetWebUpdatesForTesting } from "../src/updates/web.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

const SERVER = "a".repeat(64);
const MANIFEST = {
  version: SERVER,
  required: true,
  notes: "Faster lists",
  files: [{ path: "index.html", sha256: "c".repeat(64), size: 13 }],
};

/** Progress reports, collected. */
function recorder(): { events: UpdateProgress[]; listener: (p: UpdateProgress) => void } {
  const events: UpdateProgress[] = [];
  return { events, listener: (p) => void events.push(p) };
}

/** The stages reported, as `target:stage`. */
const stages = (events: UpdateProgress[]) => events.map((e) => `${e.target}:${e.stage}`);

/** Resolve once `promise` settles, or `"pending"` after a few ticks (a reload never settles). */
async function settledOrPending<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 50)),
  ]);
}

// --- iOS / Android ----------------------------------------------------------------------------

/** A DenextOta plugin whose `download` / `activate` run the given implementations. */
function otaPlugin(
  status: Record<string, string | null>,
  download: () => Promise<unknown> = () => Promise.resolve({}),
  activate: () => Promise<unknown> = () => new Promise(() => {}),
) {
  const calls = { download: 0, activate: [] as unknown[] };
  return {
    calls,
    plugin: {
      status: () => Promise.resolve(status),
      apply: () => Promise.resolve({}),
      booted: () => Promise.resolve(),
      reset: () => Promise.resolve(),
      download: () => (calls.download++, download()),
      activate: (o: unknown) => (calls.activate.push(o), activate()),
    },
  };
}

/** Run `fn` inside a stubbed iOS shell with `plugins`. */
async function inShell(plugins: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.getOwnPropertyDescriptor(g, "Capacitor");
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: plugins };
  try {
    await fn();
  } finally {
    if (saved) Object.defineProperty(g, "Capacitor", saved);
    else delete g.Capacitor;
  }
}

/** OTA options answering `manifest` (or an HTTP status). */
function ota(manifest: unknown = MANIFEST, status = 200): UpdatesConfig {
  return {
    ota: {
      baseUrl: "https://ui.example.com/mobile",
      fetch: (() =>
        Promise.resolve(
          status === 200 ? Response.json(manifest) : new Response("no", { status }),
        )) as typeof fetch,
    },
  };
}

Deno.test("mobile: check stages the verified UI and reports it", async () => {
  const p = otaPlugin({ current: null, bundled: "b".repeat(64), pending: null });
  await inShell({ DenextOta: p.plugin }, async () => {
    const found = await checkForUpdates(ota());
    assertEquals(found, {
      platform: "ios",
      available: true,
      updates: [{ target: "ui", version: SERVER, required: true, notes: "Faster lists" }],
      needsStoreUpdate: false,
      failures: [],
    });
    assertEquals(p.calls.download, 1);
  });
});

Deno.test("mobile: apply switches to the staged UI (the page reloads: no settle)", async () => {
  const p = otaPlugin({ current: null, bundled: "b".repeat(64), pending: null });
  await inShell({ DenextOta: p.plugin }, async () => {
    const rec = recorder();
    const run = applyUpdates(ota(), rec.listener);
    assertEquals(await settledOrPending(run), "pending");
    assertEquals(stages(rec.events), ["ui:checking", "ui:ready", "ui:applying"]);
    assertEquals(rec.events[2].version, SERVER);
    assertEquals(p.calls.activate, [{ version: SERVER }]);
  });
});

Deno.test("mobile: the running version is up to date", async () => {
  const p = otaPlugin({ current: SERVER, bundled: null, pending: null });
  await inShell({ DenextOta: p.plugin }, async () => {
    const found = await checkForUpdates(ota());
    assertEquals([found.available, found.failures], [false, []]);
    const rec = recorder();
    const done = await applyUpdates(ota(), rec.listener);
    assertEquals(stages(rec.events), ["ui:checking", "ui:up-to-date"]);
    assertEquals(done.applied, []);
  });
});

Deno.test("mobile: a UI for another native layer means a store update", async () => {
  const refuse = () =>
    Promise.reject(
      Object.assign(new Error("built for another binary"), { code: "native_mismatch" }),
    );
  const p = otaPlugin({ current: null, bundled: "b".repeat(64), pending: null }, refuse);
  await inShell({ DenextOta: p.plugin }, async () => {
    const found = await checkForUpdates(ota());
    assert(found.needsStoreUpdate);
    assertEquals(found.failures[0].code, "native_mismatch");
    const rec = recorder();
    const done = await applyUpdates(ota(), rec.listener);
    assert(done.needsStoreUpdate);
    assertEquals(rec.events.at(-1), {
      target: "ui",
      stage: "failed",
      error: "built for another binary",
      code: "native_mismatch",
    });
  });
});

Deno.test("mobile: not configured, no plugin, skipped, a refused switch, an HTTP error", async () => {
  await inShell({}, async () => {
    assertEquals((await checkForUpdates()).failures[0].code, "not_configured");
    assertEquals((await checkForUpdates(ota())).failures[0].code, "unsupported");
  });
  const busy = otaPlugin(
    { current: null, bundled: "b".repeat(64), pending: null },
    () => Promise.reject(Object.assign(new Error("busy"), { code: "busy" })),
  );
  await inShell({ DenextOta: busy.plugin }, async () => {
    assertEquals((await checkForUpdates(ota())).failures[0].code, "busy");
    assertEquals((await checkForUpdates(ota({}, 503))).failures[0].code, "failed");
  });
  const refused = otaPlugin(
    { current: null, bundled: "b".repeat(64), pending: null },
    () => Promise.resolve({}),
    () => Promise.reject(Object.assign(new Error("rolled back"), { code: "rejected" })),
  );
  await inShell({ DenextOta: refused.plugin }, async () => {
    const rec = recorder();
    const done = await applyUpdates(ota(), rec.listener);
    assertEquals(done.failures, [{ target: "ui", code: "rejected", message: "rolled back" }]);
    assertEquals(stages(rec.events).at(-1), "ui:failed");
  });
  // A shell whose plugin predates staged updates cannot switch either.
  const old = otaPlugin({ current: null, bundled: "b".repeat(64), pending: null });
  const { download: _download, activate: _activate, ...legacy } = old.plugin;
  await inShell({ DenextOta: legacy }, async () => {
    const rec = recorder();
    const done = await applyUpdates(ota(), rec.listener);
    assertEquals(done.failures[0].code, "unsupported");
    assertEquals(stages(rec.events), ["ui:checking", "ui:failed"]);
  });
});

// --- Deno Desktop -----------------------------------------------------------------------------

/** Run `fn` against a fake desktop bridge whose `updates` capability is `methods`. */
async function inDesktop(
  methods: Record<string, FakeMethod> | undefined,
  fn: (rt: ReturnType<typeof createFakeDesktopRuntime>) => Promise<void>,
): Promise<void> {
  const rt = createFakeDesktopRuntime(methods ? { updates: methods } : {});
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

Deno.test("desktop: check reports both targets; an unconfigured one is left out", async () => {
  await inDesktop({
    check: () => ({
      ui: { state: "available", version: "ui-2", required: false, notes: null },
      app: { state: "unconfigured" },
    }),
  }, async () => {
    assertEquals(await checkForUpdates(), {
      platform: "desktop",
      available: true,
      updates: [{ target: "ui", version: "ui-2", required: false, notes: null }],
      needsStoreUpdate: false,
      failures: [],
    });
  });
});

Deno.test("desktop: apply installs the overlay, then the app with forwarded progress", async () => {
  const applied: unknown[] = [];
  let rtRef: ReturnType<typeof createFakeDesktopRuntime>;
  await inDesktop({
    check: () => ({
      ui: { state: "available", version: "ui-2", required: false, notes: "n" },
      app: { state: "available", version: "2.0.0", required: true, notes: null },
    }),
    download: async (args) => {
      const { target, runId } = args as { target: string; runId: string };
      await until(() => rtRef.openStreams() > 0);
      // A replayed event from an earlier run is ignored.
      rtRef.emit("updates", "progress", { runId: "old", target, percent: 1 });
      rtRef.emit("updates", "progress", { runId, target, version: "x", percent: 40 });
      await new Promise((r) => setTimeout(r, 30));
      return { state: "ready", version: target === "ui" ? "ui-2" : "2.0.0" };
    },
    apply: (args) => {
      applied.push(args);
      return (args as { target: string }).target === "ui"
        ? { quitting: false, restartRequired: true }
        : { quitting: true, restartRequired: false };
    },
  }, async (rt) => {
    rtRef = rt;
    const rec = recorder();
    const run = applyUpdates({}, rec.listener);
    assertEquals(await settledOrPending(run), "pending"); // relaunching
    await until(() => applied.length === 2);
    assertEquals(applied, [{ target: "ui", version: "ui-2" }, { target: "app", version: "2.0.0" }]);
    assertEquals(stages(rec.events), [
      "ui:checking",
      "app:checking",
      "ui:downloading",
      "ui:ready",
      "ui:applying",
      "ui:done",
      "app:downloading",
      "app:ready",
      "app:applying",
    ]);
    assertEquals(rec.events[2], { target: "ui", stage: "downloading", version: "x", percent: 40 });
  });
});

Deno.test("desktop: only the overlay → restartRequired; the app target can be turned off", async () => {
  const downloads: unknown[] = [];
  await inDesktop({
    check: () => ({
      ui: { state: "available", version: "ui-3", required: false, notes: null },
      app: { state: "available", version: "9", required: false, notes: null },
    }),
    download: (args) => (downloads.push(args), { state: "ready", version: "ui-3" }),
    apply: () => ({ quitting: false, restartRequired: true }),
  }, async () => {
    const rec = recorder();
    const done = await applyUpdates({ desktop: { app: false } }, rec.listener);
    assertEquals(done, {
      platform: "desktop",
      applied: [{ target: "ui", version: "ui-3", required: false, notes: null }],
      restartRequired: true,
      needsStoreUpdate: false,
      failures: [],
    });
    assertEquals(downloads.length, 1);
    assertEquals(stages(rec.events), ["ui:checking", "ui:ready", "ui:applying", "ui:done"]);
  });
});

Deno.test("desktop: failures, a refused quit, nothing newer, and the capability off", async () => {
  await inDesktop({
    check: () => ({
      ui: { state: "failed", code: "signature", message: "bad signature" },
      app: { state: "available", version: "2", required: false, notes: null },
    }),
    download: () => ({ state: "ready", version: "2" }),
    apply: () => ({ quitting: false }),
  }, async () => {
    const found = await checkForUpdates();
    assertEquals(found.failures, [{ target: "ui", code: "signature", message: "bad signature" }]);
    const rec = recorder();
    const done = await applyUpdates({}, rec.listener);
    assertEquals(done.failures.map((f) => f.code), ["signature", "quit_refused"]);
    assertEquals(stages(rec.events).filter((s) => s.endsWith("failed")), [
      "ui:failed",
      "app:failed",
    ]);
  });
  await inDesktop({
    check: () => ({ ui: { state: "available", version: "u" }, app: { state: "up-to-date" } }),
    download: () => {
      throw { code: "integrity", message: "SHA-256 mismatch for app.js" };
    },
  }, async () => {
    const done = await applyUpdates();
    assertEquals(done.failures, [
      { target: "ui", code: "integrity", message: "SHA-256 mismatch for app.js" },
    ]);
  });
  await inDesktop({
    check: () => ({ ui: { state: "available", version: "u" }, app: { state: "unsupported" } }),
    download: () => ({ state: "up-to-date" }),
  }, async () => {
    const rec = recorder();
    const done = await applyUpdates({}, rec.listener);
    assertEquals(done.applied, []);
    assertEquals(stages(rec.events), [
      "ui:checking",
      "app:checking",
      "ui:up-to-date",
      "app:up-to-date",
    ]);
  });
  await inDesktop({
    check: () => ({ ui: { state: "available", version: "u" }, app: { state: "up-to-date" } }),
    download: () => ({ state: "ready", version: "u" }),
    apply: () => {
      throw { code: "not_staged", message: "u is not staged" };
    },
  }, async () => {
    assertEquals((await applyUpdates()).failures[0].code, "not_staged");
  });
  await inDesktop(undefined, async () => {
    const found = await checkForUpdates();
    assertEquals(found.failures.map((f) => `${f.target}:${f.code}`), [
      "ui:unavailable",
      "app:unavailable",
    ]);
    assert(found.failures[0].message.includes("denext desktop add updates"));
    const done = await applyUpdates({ desktop: { ui: false } });
    assertEquals(done.failures.map((f) => f.target), ["app"]);
  });
});

// --- a browser tab ----------------------------------------------------------------------------

/** A web config whose version endpoint answers `bodies` in turn. */
function web(bodies: Array<() => Response>, extra: Partial<UpdatesConfig["web"]> = {}) {
  let i = 0;
  const reloads: number[] = [];
  const config: UpdatesConfig = {
    web: {
      fetch: (() => Promise.resolve(bodies[Math.min(i++, bodies.length - 1)]())) as typeof fetch,
      reload: () => void reloads.push(1),
      ...extra,
    },
  };
  return { config, reloads };
}

Deno.test("web: the first version read is this page's; a newer deploy reloads", async () => {
  resetWebUpdatesForTesting();
  const { config, reloads } = web([
    () => Response.json(MANIFEST),
    () => Response.json(MANIFEST),
    () => Response.json({ buildId: "build-2" }),
    () => Response.json({ buildId: "build-2" }),
  ]);
  assertEquals((await checkForUpdates(config)).available, false);
  assertEquals((await applyUpdates(config)).applied, []);
  assertEquals(await checkForUpdates(config), {
    platform: "web",
    available: true,
    updates: [{ target: "web", version: "build-2", required: false, notes: null }],
    needsStoreUpdate: false,
    failures: [],
  });
  const rec = recorder();
  assertEquals(await settledOrPending(applyUpdates(config, rec.listener)), "pending");
  assertEquals(stages(rec.events), ["web:checking", "web:ready", "web:applying"]);
  assertEquals(reloads.length, 1);
});

Deno.test("web: an explicit current version, text and JSON version bodies", async () => {
  resetWebUpdatesForTesting();
  const text = web([() => new Response("v7\n")], { currentVersion: "v6" });
  assertEquals((await checkForUpdates(text.config)).updates[0].version, "v7");
  const json = web([() => Response.json({ version: "v6" })], { currentVersion: "v6" });
  assertEquals((await checkForUpdates(json.config)).available, false);
  const num = web([() => Response.json(42)], { currentVersion: "41" });
  assertEquals((await checkForUpdates(num.config)).updates[0].version, "42");
});

Deno.test("web: no version to read, an HTTP error, a network error, a timeout", async () => {
  resetWebUpdatesForTesting();
  const html = web([() => new Response("<!doctype html><p>not found</p>")]);
  assertEquals((await checkForUpdates(html.config)).failures[0].code, "no_version");
  const empty = web([() => Response.json({ other: true })]);
  assertEquals((await checkForUpdates(empty.config)).failures[0].code, "no_version");
  const missing = web([() => new Response("gone", { status: 404 })]);
  const rec = recorder();
  const done = await applyUpdates(missing.config, rec.listener);
  assertEquals(done.failures[0].code, "no_version");
  assertEquals(stages(rec.events), ["web:checking", "web:failed"]);
  const down: UpdatesConfig = {
    web: { fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch },
  };
  assertEquals((await checkForUpdates(down)).failures[0], {
    target: "web",
    code: "network",
    message: "offline",
  });
  const slow: UpdatesConfig = {
    web: {
      timeoutMs: 5,
      fetch:
        ((_u: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted")))
          )) as typeof fetch,
    },
  };
  assert((await checkForUpdates(slow)).failures[0].message.includes("did not answer"));
});

Deno.test("updates: a throwing config or listener never escapes", async () => {
  resetWebUpdatesForTesting();
  const broken = {
    get web(): never {
      throw new Error("bad config");
    },
  } as UpdatesConfig;
  assertEquals((await checkForUpdates(broken)).failures, [
    { target: "web", code: "failed", message: "bad config" },
  ]);
  const done = await applyUpdates(broken, () => {
    throw new Error("listener bug");
  });
  assertEquals(done.failures[0].message, "bad config");
});
