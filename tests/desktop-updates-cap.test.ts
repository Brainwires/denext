// The Deno Desktop `updates` capability (runtime side): check / download (with throttled progress
// events) / apply for the signed UI overlay and the whole app, over fake updaters; its wiring from
// `desktop.update` + `desktop.capabilities.updates` (resolveDesktopCapabilities), the config
// validation of `desktop.update.ui`, and the least-privilege flags it bakes.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { DesktopCapability, DesktopCapCtx } from "../src/desktop/extension.ts";
import {
  type AppUpdaterApi,
  type UiUpdaterApi,
  updatesCapability,
} from "../src/desktop/caps/updates.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import { DesktopUpdateError } from "../src/desktop/updater.ts";
import { AppUpdateError } from "../src/desktop/app-updater.ts";
import {
  DESKTOP_BASELINE_FLAGS,
  DESKTOP_CAPABILITIES,
  desktopBuildFlags,
} from "../src/build/desktop-capabilities.ts";
import { DESKTOP_ADD_CAPABILITY_KEYS } from "../src/desktop/config-types.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

const UI = { feedUrl: "https://ui.example.com/feed", publicKey: "PUBKEY", appId: "com.x.app" };
const APP = { manifestUrl: "https://dl.example.com/app-update.json" };

/** A handler context recording what the capability emits. */
function ctxOf(signal = new AbortController().signal) {
  const emitted: Array<[string, unknown]> = [];
  const ctx: DesktopCapCtx = {
    emit: (event, data) => void emitted.push([event, data]),
    appSupportDir: "/tmp/app",
    runOnMainThread: () => Promise.reject(new Error("no UI thread")),
    os: "darwin",
    signal,
  };
  return { ctx, emitted };
}

/** Call `cap.method(args)` the way the bridge does. */
function call(
  cap: DesktopCapability,
  method: string,
  args: unknown = {},
  ctx: DesktopCapCtx = ctxOf().ctx,
): Promise<unknown> {
  return Promise.resolve(cap.methods[method].handler(args, ctx));
}

/** The code a promise rejects with. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
  throw new Error("expected a rejection");
}

/** A fake overlay updater: offers `offer` (or nothing), records applies. */
function fakeUi(offer?: string, fail?: Error) {
  const applied: string[] = [];
  let prepared = 0;
  const api: UiUpdaterApi = {
    check: () =>
      fail ? Promise.reject(fail) : Promise.resolve(
        offer
          ? { available: true, version: offer, required: true, notes: "fixes" }
          : { available: false },
      ),
    prepare: () => {
      prepared++;
      return Promise.resolve({ version: offer!, required: true, notes: "fixes" });
    },
    apply: (version) => (applied.push(version), Promise.resolve()),
  };
  return { api, applied, prepared: () => prepared };
}

/** A fake full-app updater: offers `offer`, reports `steps` of progress while downloading. */
function fakeApp(
  offer?: string,
  opts: { fail?: Error; steps?: number[]; quitting?: boolean } = {},
) {
  let installs = 0;
  const api: AppUpdaterApi = {
    check: () =>
      opts.fail ? Promise.reject(opts.fail) : Promise.resolve({
        available: offer !== undefined,
        version: offer ?? "1.0.0",
        currentVersion: "1.0.0",
        required: false,
        releaseNotes: offer ? "new" : null,
        publishedAt: null,
        size: 1000,
        sequence: 3,
        expiresAt: null,
      }),
    download: (_config, { onProgress }) => {
      for (const transferred of opts.steps ?? []) onProgress?.({ transferred, total: 1000 });
      return Promise.resolve({ version: offer!, signatureMode: "team", signer: "TEAM" });
    },
    install: () => (installs++, Promise.resolve({ quitting: opts.quitting ?? true })),
  };
  return { api, installs: () => installs };
}

Deno.test("updates.check: each target's state; an unconfigured target says so", async () => {
  const cap = updatesCapability({
    ui: UI,
    app: APP,
    uiApi: fakeUi("v2").api,
    appApi: fakeApp().api,
  });
  assertEquals(await call(cap, "check"), {
    ui: { state: "available", version: "v2", required: true, notes: "fixes" },
    app: { state: "up-to-date" },
  });
  const none = updatesCapability({ uiApi: fakeUi("v2").api, appApi: fakeApp("2.0.0").api });
  assertEquals(await call(none, "check"), {
    ui: { state: "unconfigured" },
    app: { state: "unconfigured" },
  });
  assertEquals(cap.events, ["progress"]);
});

Deno.test("updates.check: a refused manifest is a failed state with the updater's code", async () => {
  const cap = updatesCapability({
    ui: UI,
    app: APP,
    uiApi: fakeUi(undefined, new DesktopUpdateError("signature", "bad signature")).api,
    appApi: fakeApp(undefined, { fail: new AppUpdateError("expired", "manifest expired") }).api,
  });
  assertEquals(await call(cap, "check"), {
    ui: { state: "failed", code: "signature", message: "bad signature" },
    app: { state: "failed", code: "expired", message: "manifest expired" },
  });
  // The stock runtime has no full-app updater: unsupported, not a failure.
  const stock = updatesCapability({
    app: APP,
    appApi: fakeApp(undefined, { fail: new AppUpdateError("unsupported", "no updater") }).api,
  });
  assertEquals((await call(stock, "check") as { app: unknown }).app, { state: "unsupported" });
});

Deno.test("updates.check: an io failure or a codeless throw gets a fixed message", async () => {
  const cap = updatesCapability({
    ui: UI,
    app: APP,
    uiApi: fakeUi(undefined, new Error("/Users/me/secret")).api,
    appApi: fakeApp(undefined, { fail: new AppUpdateError("io", "EACCES /Applications/X") }).api,
  });
  assertEquals(await call(cap, "check"), {
    ui: { state: "failed", code: "failed", message: "the update failed" },
    app: { state: "failed", code: "io", message: "the update failed" },
  });
});

Deno.test("updates.download ui: stages the overlay, pushes 0 % and 100 % for the run", async () => {
  const ui = fakeUi("v2");
  const cap = updatesCapability({ ui: UI, uiApi: ui.api });
  const { ctx, emitted } = ctxOf();
  assertEquals(await call(cap, "download", { target: "ui", runId: "r1" }, ctx), {
    state: "ready",
    version: "v2",
    required: true,
    notes: "fixes",
  });
  assertEquals(ui.prepared(), 1);
  assertEquals(emitted, [
    ["progress", { runId: "r1", target: "ui", stage: "downloading", version: "v2", percent: 0 }],
    ["progress", { runId: "r1", target: "ui", stage: "downloading", version: "v2", percent: 100 }],
  ]);
  // Nothing newer: nothing is staged.
  const current = updatesCapability({ ui: UI, uiApi: fakeUi().api });
  assertEquals(await call(current, "download", { target: "ui" }), { state: "up-to-date" });
});

Deno.test("updates.download app: progress is throttled to 5 % steps", async () => {
  const app = fakeApp("2.0.0", { steps: [10, 20, 30, 60, 70, 110, 500, 990, 1000] });
  const cap = updatesCapability({ app: APP, appApi: app.api });
  const { ctx, emitted } = ctxOf();
  assertEquals(await call(cap, "download", { target: "app", runId: "x".repeat(65) }, ctx), {
    state: "ready",
    version: "2.0.0",
    required: false,
    notes: "new",
  });
  const percents = emitted.map(([, d]) => (d as { percent: number }).percent);
  assertEquals(percents, [0, 6, 11, 50, 99, 100]);
  // An over-long run id is dropped (the page's own ids are UUIDs).
  assertEquals((emitted[0][1] as { runId: unknown }).runId, null);
  const current = updatesCapability({ app: APP, appApi: fakeApp().api });
  assertEquals(await call(current, "download", { target: "app" }), { state: "up-to-date" });
});

Deno.test("updates.download: validation, not_configured, busy and the updater's refusals", async () => {
  const cap = updatesCapability({ uiApi: fakeUi("v2").api, appApi: fakeApp("2").api });
  assertEquals(await codeOf(call(cap, "download", { target: "os" })), "validation");
  assertEquals(await codeOf(call(cap, "download", null)), "validation");
  assertEquals(await codeOf(call(cap, "download", { target: "ui" })), "not_configured");
  assertEquals(await codeOf(call(cap, "download", { target: "app" })), "not_configured");

  // A second download of the same target while one runs is `busy`.
  let release!: () => void;
  const slow: UiUpdaterApi = {
    ...fakeUi("v2").api,
    prepare: () =>
      new Promise((resolve) => {
        release = () => resolve({ version: "v2", required: false, notes: null });
      }),
  };
  const busy = updatesCapability({ ui: UI, uiApi: slow });
  const first = call(busy, "download", { target: "ui" });
  while (release === undefined) await new Promise((r) => setTimeout(r, 1));
  assertEquals(await codeOf(call(busy, "download", { target: "ui" })), "busy");
  release();
  assertEquals((await first as { state: string }).state, "ready");

  const refused = updatesCapability({
    app: APP,
    appApi: {
      ...fakeApp("2").api,
      download: () => Promise.reject(new AppUpdateError("os_signature", "another Team ID")),
    },
  });
  const err = await assertRejects(() => call(refused, "download", { target: "app" }));
  assertEquals((err as { code: string }).code, "os_signature");
  assertEquals((err as Error).message, "another Team ID");
});

Deno.test("updates.apply ui: switches the pointer; the overlay serves from the next launch", async () => {
  const ui = fakeUi("v2");
  const cap = updatesCapability({ ui: UI, uiApi: ui.api });
  assertEquals(await call(cap, "apply", { target: "ui", version: "v2" }), {
    quitting: false,
    restartRequired: true,
  });
  assertEquals(ui.applied, ["v2"]);
  assertEquals(await codeOf(call(cap, "apply", { target: "ui" })), "validation");
  const notStaged = updatesCapability({
    ui: UI,
    uiApi: {
      ...ui.api,
      apply: () => Promise.reject(new DesktopUpdateError("not_staged", "v3 is not staged")),
    },
  });
  assertEquals(
    await codeOf(call(notStaged, "apply", { target: "ui", version: "v3" })),
    "not_staged",
  );
});

Deno.test("updates.apply app: installs and quits; a refused quit is reported", async () => {
  const app = fakeApp("2");
  const cap = updatesCapability({ app: APP, appApi: app.api });
  assertEquals(await call(cap, "apply", { target: "app" }), {
    quitting: true,
    restartRequired: false,
  });
  assertEquals(app.installs(), 1);
  const held = updatesCapability({ app: APP, appApi: fakeApp("2", { quitting: false }).api });
  assertEquals(
    (await call(held, "apply", { target: "app" }) as { quitting: boolean }).quitting,
    false,
  );
  assertEquals(
    await codeOf(call(updatesCapability({}), "apply", { target: "app" })),
    "not_configured",
  );
});

Deno.test("updates: the real updaters load on demand and refuse safely", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Unreachable feed and no pinned runtime: every call answers, none throws past the bridge.
    const cap = updatesCapability({
      ui: { ...UI, feedUrl: "http://127.0.0.1:9/feed", dataDir: dir, timeoutMs: 2000 },
      app: APP,
    });
    const checked = await call(cap, "check") as {
      ui: { state: string; code?: string };
      app: { state: string };
    };
    assertEquals(checked.ui.state, "failed");
    assertEquals(checked.ui.code, "network");
    assertEquals(checked.app.state, "unsupported");
    assertEquals(await codeOf(call(cap, "apply", { target: "ui", version: "v9" })), "not_staged");
    assertEquals(await codeOf(call(cap, "apply", { target: "app" })), "unsupported");
    assertEquals(await codeOf(call(cap, "download", { target: "app" })), "unsupported");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveDesktopCapabilities: `updates` + desktop.update wire the cap and the overlay", async () => {
  const resolved = await resolveDesktopCapabilities({
    desktop: {
      app: { identifier: "com.example.updates" },
      capabilities: { updates: true },
      update: {
        manifestUrl: "https://dl.example.com/u.json",
        ui: { feedUrl: "https://ui.example.com", publicKey: "KEY", platform: "linux" },
      },
    },
  });
  assertEquals(resolved.updater, {
    feedUrl: "https://ui.example.com",
    publicKey: "KEY",
    appId: "com.example.updates",
    platform: "linux",
  });
  const cap = resolved.capabilities.find((c) => c.name === "updates");
  assert(cap, "the updates capability is enabled");
  assertEquals(Object.keys(cap.methods).sort(), ["apply", "check", "download"]);

  // Without the capability the overlay is still served; without update.ui nothing is.
  const served = await resolveDesktopCapabilities({
    desktop: {
      app: { identifier: "com.example.updates" },
      update: { ui: { feedUrl: "https://ui.example.com", publicKey: "KEY" } },
    },
  });
  assertEquals(served.updater?.appId, "com.example.updates");
  assertEquals(served.updater?.platform, undefined);
  assertEquals(served.capabilities, []);
  const bare = await resolveDesktopCapabilities({ desktop: { capabilities: { updates: true } } });
  assertEquals(bare.updater, undefined);
  assertEquals(bare.capabilities.map((c) => c.name), ["updates"]);
});

Deno.test("resolveDesktopCapabilities: desktop.update.ui fails fast when incomplete", async () => {
  const bad = (ui: unknown, identifier = "com.example.x") =>
    resolveDesktopCapabilities({
      desktop: { ...(identifier ? { app: { identifier } } : {}), update: { ui } },
    });
  await assertRejects(() => bad({ publicKey: "K" }), Error, "feedUrl");
  await assertRejects(() => bad({ feedUrl: "https://u", publicKey: "" }), Error, "publicKey");
  await assertRejects(() => bad(null), Error, "feedUrl");
  await assertRejects(
    () => bad({ feedUrl: "https://u", publicKey: "K" }, ""),
    Error,
    "desktop.app.identifier",
  );
});

Deno.test("config validation: desktop.update.ui needs an absolute feed URL and a key", () => {
  const cfg = (ui: unknown) => ({ desktop: { update: { ui } } }) as unknown as DenextConfig;
  validateDenextConfig(cfg({ feedUrl: "https://ui.example.com", publicKey: "K" }));
  assertThrows(() => validateDenextConfig(cfg("x")), Error, "desktop.update.ui");
  assertThrows(
    () => validateDenextConfig(cfg({ feedUrl: "/rel", publicKey: "K" })),
    Error,
    "feedUrl",
  );
  assertThrows(
    () => validateDenextConfig(cfg({ feedUrl: "https://u.example", publicKey: 1 })),
    Error,
    "publicKey",
  );
});

Deno.test("catalog + flags: `updates` writes app data; the overlay feed host joins --allow-net", () => {
  assertEquals(DESKTOP_CAPABILITIES.updates.key, "updates");
  assert((DESKTOP_ADD_CAPABILITY_KEYS as readonly string[]).includes("updates"));
  assertEquals(desktopBuildFlags({ desktop: { capabilities: { updates: true } } }, "linux"), [
    ...DESKTOP_BASELINE_FLAGS,
    "--allow-write",
  ]);
  assertEquals(
    desktopBuildFlags({
      desktop: {
        update: {
          manifestUrl: "https://dl.example.com/u.json",
          ui: { feedUrl: "https://ui.example.com/feed", publicKey: "K" },
        },
      },
    }, "darwin"),
    [
      "--allow-net=127.0.0.1,dl.example.com,localhost,ui.example.com",
      "--allow-read",
      "--allow-env",
      "--allow-write",
    ],
  );
  // An invalid feed URL adds no host (the config validator reports it).
  assertEquals(
    desktopBuildFlags(
      { desktop: { update: { ui: { feedUrl: "::bad", publicKey: "K" } } } },
      "linux",
    )[0],
    "--allow-net=127.0.0.1,localhost",
  );
});
