// Full-app self-update, denext's half: the archive `denext desktop publish-update` packs (it must
// extract under the same safe-extraction rules the runtime enforces), the signed manifest (format,
// domain-separated ECDSA P-256 signature, the cross-language vector the Rust runtime also
// verifies), publishing and merging per platform, the baked key in `.deno-desktop/app.json`, the
// updater hosts in the packaged `--allow-net`, and the `denext/desktop/updater` wrappers over the
// runtime's `Deno.desktop.updater`. The adversarial checks of the install itself (downgrade, wrong
// app, size overflow, tar-slip, Team ID, swap rollback, ...) run in the runtime's Rust tests.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  APP_UPDATE_MANIFEST_FILE,
  type AppUpdatePayload,
  appUpdatePlatformKey,
  isAppUpdatePlatform,
  isAppUpdateVersion,
  publishAppUpdate,
  signAppUpdatePayload,
  validateAppUpdatePayload,
  verifyAppUpdateEnvelope,
  writeAppUpdateArchive,
} from "../src/build/app-update.ts";
import { extractArchive } from "../src/build/safe-extract.ts";
import { generateOtaKeyPair, importOtaSigningKey } from "../src/build/ota-signing.ts";
import {
  DESKTOP_APP_CONFIG_FILE,
  syncDesktopAppConfigAt,
} from "../src/build/desktop-app-config.ts";
import { desktopBuildFlags } from "../src/build/desktop-capabilities.ts";
import {
  AppUpdateError,
  appUpdateStatus,
  checkForAppUpdate,
  confirmAppUpdate,
  downloadAppUpdate,
  installAppUpdateAndRelaunch,
} from "../src/desktop/updater.ts";

const VECTOR = new URL("./fixtures/app-update-vector/", import.meta.url);
const posix = Deno.build.os !== "windows";

async function keys(): Promise<{ key: CryptoKey; publicKey: string }> {
  const pair = await generateOtaKeyPair();
  return { key: await importOtaSigningKey(pair.privateKeyPem), publicKey: pair.publicKey };
}

function payload(over: Partial<AppUpdatePayload> = {}): AppUpdatePayload {
  return {
    schema: 1,
    app: "com.example.app",
    version: "2.0.0",
    platforms: {
      "aarch64-apple-darwin-webview": {
        url: "https://updates.example.com/a.tar.gz",
        sha256: "a".repeat(64),
        size: 10,
        kind: "bundle",
      },
    },
    publishedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

/** A fake packaged app dir: an executable, a nested long path, and (POSIX) a relative symlink. */
async function fakeApp(root: string, name = "My App.app"): Promise<string> {
  const app = join(root, name);
  const deep = join(app, "Contents", "Frameworks", "x".repeat(60), "y".repeat(60));
  await Deno.mkdir(deep, { recursive: true });
  await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await Deno.writeTextFile(join(app, "Contents", "MacOS", "app"), "#!/bin/sh\necho v2\n");
  await Deno.writeTextFile(join(deep, "long-file.txt"), "deep");
  if (posix) {
    await Deno.chmod(join(app, "Contents", "MacOS", "app"), 0o755);
    await Deno.symlink("MacOS/app", join(app, "Contents", "current"));
  }
  return app;
}

Deno.test("archive: one top-level entry that the safe extractor accepts (long names, modes, symlinks)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const app = await fakeApp(dir);
    const out = join(dir, "a.tar.gz");
    const { sha256, size } = await writeAppUpdateArchive(app, out);
    assertEquals(size, (await Deno.stat(out)).size);
    assert(/^[0-9a-f]{64}$/.test(sha256));
    const dest = join(dir, "x");
    const r = await extractArchive(out, "tar.gz", dest);
    const longRel = `My App.app/Contents/Frameworks/${"x".repeat(60)}/${
      "y".repeat(60)
    }/long-file.txt`;
    assert(r.files[longRel], "a >100-byte path survives through a pax header");
    assertEquals(await Deno.readTextFile(join(dest, ...longRel.split("/"))), "deep");
    if (posix) {
      assertEquals(r.symlinks["My App.app/Contents/current"], "MacOS/app");
      const mode = (await Deno.stat(join(dest, "My App.app", "Contents", "MacOS", "app"))).mode!;
      assertEquals(mode & 0o777, 0o755);
    }
    // Exactly one top-level entry.
    const tops = new Set(Object.keys(r.files).map((p) => p.split("/")[0]));
    assertEquals([...tops], ["My App.app"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive: a single file (an AppImage) is its own top-level entry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const image = join(dir, "My.AppImage");
    await Deno.writeFile(image, new Uint8Array(1500).fill(7));
    await writeAppUpdateArchive(image, join(dir, "a.tar.gz"));
    const r = await extractArchive(join(dir, "a.tar.gz"), "tar.gz", join(dir, "x"));
    assertEquals(Object.keys(r.files), ["My.AppImage"]);
    assertEquals(r.files["My.AppImage"].size, 1500);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("archive: a symlinked app root is refused (pass the real app)", {
  ignore: !posix,
}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    const app = await fakeApp(dir);
    await Deno.symlink(app, join(dir, "link.app"));
    await assertRejects(
      () => writeAppUpdateArchive(join(dir, "link.app"), join(dir, "a.tar.gz")),
      Error,
      "is a symlink; pass the real app",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("manifest: signed envelope verifies; tampering, a wrong key and a bare manifest do not", async () => {
  const { key, publicKey } = await keys();
  const env = await signAppUpdatePayload(payload(), key);
  assertEquals(Object.keys(env).sort(), ["signature", "signed"]);
  assertEquals((await verifyAppUpdateEnvelope(env, publicKey)).version, "2.0.0");
  const tampered = { ...env, signed: env.signed.replace("a.tar.gz", "evil.tar.gz") };
  await assertRejects(() => verifyAppUpdateEnvelope(tampered, publicKey), Error, "does not verify");
  const other = await keys();
  await assertRejects(
    () => verifyAppUpdateEnvelope(env, other.publicKey),
    Error,
    "does not verify",
  );
  await assertRejects(() => verifyAppUpdateEnvelope(JSON.parse(env.signed), publicKey));
  await assertRejects(() => verifyAppUpdateEnvelope({ ...env, extra: 1 }, publicKey));
});

Deno.test("manifest: the signature is domain-separated from OTA UI manifests", async () => {
  const { key, publicKey } = await keys();
  const env = await signAppUpdatePayload(payload(), key);
  // The same key signing the bare payload (another protocol's bytes) does not verify here.
  const bare = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(env.signed),
    ),
  );
  const forged = { signed: env.signed, signature: btoa(String.fromCharCode(...bare)) };
  await assertRejects(() => verifyAppUpdateEnvelope(forged, publicKey), Error, "does not verify");
});

Deno.test("manifest: the cross-language vector (also verified by the runtime's Rust test)", async () => {
  const env = JSON.parse(await Deno.readTextFile(new URL("webcrypto_vector.json", VECTOR)));
  const pub = await Deno.readTextFile(new URL("webcrypto_vector.pub", VECTOR));
  const p = await verifyAppUpdateEnvelope(env, pub);
  assertEquals(p.app, "com.example.vector");
  assertEquals(p.platforms["x86_64-unknown-linux-gnu-webview"].size, 4242);
});

Deno.test("manifest: publishing refuses what every installed app would refuse", () => {
  validateAppUpdatePayload(payload());
  const bad: [string, AppUpdatePayload][] = [
    ["semver", payload({ version: "v2.0.0" })],
    ["semver", payload({ minVersion: "1.0" })],
    [
      "https",
      payload({
        platforms: {
          "aarch64-apple-darwin-webview": {
            ...payload().platforms["aarch64-apple-darwin-webview"],
            url: "http://x/a",
          },
        },
      }),
    ],
    [
      "platform",
      payload({
        platforms: {
          "sparc-sun-solaris-webview": payload().platforms["aarch64-apple-darwin-webview"],
        },
      }),
    ],
    [
      "sha256",
      payload({
        platforms: {
          "aarch64-apple-darwin-webview": {
            ...payload().platforms["aarch64-apple-darwin-webview"],
            sha256: "A".repeat(64),
          },
        },
      }),
    ],
    ["platforms", payload({ platforms: {} })],
  ];
  const entry = (over: Partial<AppUpdatePayload["platforms"][string]>) =>
    payload({
      platforms: {
        "aarch64-apple-darwin-webview": {
          ...payload().platforms["aarch64-apple-darwin-webview"],
          ...over,
        },
      },
    });
  // Each refusal names its problem (the message the publisher sees).
  const named: [string, AppUpdatePayload][] = [
    ["schema must be 1", payload({ schema: 2 as 1 })],
    ["app (the identifier) is required", payload({ app: "" })],
    ["minVersion 1.0 is not a semver", payload({ minVersion: "1.0" })],
    ["publishedAt is required", payload({ publishedAt: "" })],
    ["publishedAt is required", payload({ publishedAt: "x".repeat(65) })],
    ['kind must be "bundle"', entry({ kind: "delta" as "bundle" })],
    ["bad size", entry({ size: 0 })],
    ["bad size", entry({ size: 1.5 })],
    ["the archive url must be https", entry({ url: "http://x/a" })],
    ["no credentials in the url", entry({ url: "https://u:p@x.example/a.tar.gz" })],
  ];
  for (const [message, p] of named) {
    assertThrows(() => validateAppUpdatePayload(p), Error, message);
  }
  for (const [what, p] of bad) {
    assertThrows(() => validateAppUpdatePayload(p), Error, undefined, what);
  }
});

Deno.test("platform keys and versions follow the runtime's rules", async () => {
  assert(isAppUpdatePlatform("aarch64-apple-darwin-webview"));
  assert(isAppUpdatePlatform("x86_64-unknown-linux-gnu-cef-appimage"));
  assert(!isAppUpdatePlatform("x86_64-apple-darwin-webview-appimage"));
  assert(!isAppUpdatePlatform("x86_64-apple-darwin-gtk"));
  assert(isAppUpdateVersion("1.2.3-rc.1+build.5"));
  assert(!isAppUpdateVersion("01.2.3"));
  const dir = await Deno.makeTempDir();
  try {
    const app = await fakeApp(dir, "A.app");
    assertEquals(
      await appUpdatePlatformKey(app, "x86_64-apple-darwin"),
      "x86_64-apple-darwin-webview",
    );
    await Deno.mkdir(join(app, "Contents", "Frameworks", "Chromium Embedded Framework.framework"));
    assertEquals(
      await appUpdatePlatformKey(app, "aarch64-apple-darwin"),
      "aarch64-apple-darwin-cef",
    );
    // An explicit backend skips detection; an AppImage gets its own key; an unknown target is
    // refused before anything is packed.
    assertEquals(
      await appUpdatePlatformKey(join(dir, "My.AppImage"), "x86_64-unknown-linux-gnu", "cef"),
      "x86_64-unknown-linux-gnu-cef-appimage",
    );
    await assertRejects(
      () => appUpdatePlatformKey(app, "sparc-sun-solaris", "webview"),
      Error,
      "unsupported platform sparc-sun-solaris-webview",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publishAppUpdate: signed manifest + archive; another platform of the same release merges", async () => {
  const { key, publicKey } = await keys();
  const dir = await Deno.makeTempDir();
  try {
    const app = await fakeApp(dir, "App.app");
    const out = join(dir, "updates");
    const common = {
      app: "com.example.app",
      urlBase: "https://u.example.com/rel",
      outDir: out,
      key,
    };
    const a = await publishAppUpdate({
      ...common,
      artifact: app,
      version: "2.0.0",
      platform: "aarch64-apple-darwin-webview",
      minVersion: "1.5.0",
      releaseNotes: "notes",
    });
    assertEquals(a.manifest, join(out, APP_UPDATE_MANIFEST_FILE));
    const env1 = JSON.parse(await Deno.readTextFile(a.manifest));
    const p1 = await verifyAppUpdateEnvelope(env1, publicKey);
    const e1 = p1.platforms["aarch64-apple-darwin-webview"];
    assertEquals(
      e1.url,
      "https://u.example.com/rel/com.example.app-2.0.0-aarch64-apple-darwin-webview.tar.gz",
    );
    assertEquals(e1.size, (await Deno.stat(a.archive)).size);
    assertEquals(e1.sha256, a.sha256);
    // A second platform of 2.0.0 keeps the first (and the notes / minVersion).
    const b = await publishAppUpdate({
      ...common,
      artifact: app,
      version: "2.0.0",
      platform: "x86_64-apple-darwin-webview",
    });
    assertEquals(b.platforms, ["aarch64-apple-darwin-webview", "x86_64-apple-darwin-webview"]);
    const p2 = await verifyAppUpdateEnvelope(
      JSON.parse(await Deno.readTextFile(b.manifest)),
      publicKey,
    );
    assertEquals(p2.minVersion, "1.5.0");
    assertEquals(p2.releaseNotes, "notes");
    // A new release replaces the platform list.
    const c = await publishAppUpdate({
      ...common,
      artifact: app,
      version: "2.1.0",
      platform: "x86_64-apple-darwin-webview",
    });
    assertEquals(c.platforms, ["x86_64-apple-darwin-webview"]);
    // https only.
    await assertRejects(
      () =>
        publishAppUpdate({
          ...common,
          urlBase: "http://u.example.com/",
          artifact: app,
          version: "3.0.0",
          platform: "x86_64-apple-darwin-webview",
        }),
      Error,
      "https",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("app.json bakes desktop.update.publicKey (normalized); a bad key or no identifier is refused", async () => {
  const { publicKey } = await keys();
  const pem = `-----BEGIN PUBLIC KEY-----\n${
    publicKey.match(/.{1,64}/g)!.join("\n")
  }\n-----END PUBLIC KEY-----\n`;
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    const config = {
      desktop: { app: { identifier: "com.example.app" }, update: { publicKey: pem } },
    };
    await syncDesktopAppConfigAt(dir, config);
    const body = JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE)));
    assertEquals(body.update, { publicKey });
    assertEquals(body.identifier, "com.example.app");
    await assertRejects(
      () =>
        syncDesktopAppConfigAt(dir, {
          desktop: { app: { identifier: "com.example.app" }, update: { publicKey: "nope" } },
        }),
      Error,
      "invalid desktop.update.publicKey",
    );
    await assertRejects(
      () => syncDesktopAppConfigAt(dir, { desktop: { update: { publicKey } } }),
      Error,
      "desktop.app.identifier",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopBuildFlags: the update manifest host and extra hosts join the single --allow-net", () => {
  const flags = desktopBuildFlags({
    desktop: {
      update: {
        manifestUrl: "https://updates.example.com/app/app-update.json",
        hosts: ["cdn.example.net"],
      },
    },
  }, "darwin");
  assertEquals(flags[0], "--allow-net=127.0.0.1,cdn.example.net,localhost,updates.example.com");
  assertEquals(flags.filter((f) => f.startsWith("--allow-net")).length, 1);
});

// ---------------------------------------------------------------------------------------------
// The wrappers over `Deno.desktop.updater`.

type Stub = Record<string, (...args: unknown[]) => unknown>;

async function withRuntime(updater: Stub | undefined, f: () => Promise<void>): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(Deno, "desktop");
  Object.defineProperty(Deno, "desktop", {
    value: updater ? { updater } : undefined,
    configurable: true,
  });
  try {
    await f();
  } finally {
    if (had) Object.defineProperty(Deno, "desktop", had);
    else delete (Deno as unknown as Record<string, unknown>).desktop;
  }
}

function runtimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "AppUpdateError", code });
}

Deno.test("wrappers: outside the pinned runtime → unsupported (confirm and status are no-ops)", async () => {
  await withRuntime(undefined, async () => {
    const e = await assertRejects(
      () => checkForAppUpdate({ manifestUrl: "https://x/a.json" }),
      AppUpdateError,
    );
    assertEquals(e.code, "unsupported");
    assertThrows(() => installAppUpdateAndRelaunch(), AppUpdateError);
    assertEquals(confirmAppUpdate(), false);
    assertEquals(appUpdateStatus(), null);
  });
});

Deno.test("wrappers: runtime refusals surface as AppUpdateError with the runtime's code", async () => {
  for (
    const code of [
      "signature",
      "downgrade",
      "wrong_app",
      "size_exceeded",
      "os_signature",
      "install_not_writable",
    ]
  ) {
    await withRuntime({
      check: () => Promise.reject(runtimeError(code, `refused: ${code}`)),
    }, async () => {
      const e = await assertRejects(
        () => checkForAppUpdate({ manifestUrl: "https://x/a.json" }),
        AppUpdateError,
      );
      assertEquals(e.code, code);
      assertStringIncludes(e.message, code);
    });
  }
  // An unknown code is not passed through as-is.
  await withRuntime({ check: () => Promise.reject(runtimeError("weird", "x")) }, async () => {
    const e = await assertRejects(
      () => checkForAppUpdate({ manifestUrl: "https://x/a.json" }),
      AppUpdateError,
    );
    assertEquals(e.code, "io");
  });
});

Deno.test("wrappers: download stages with the dev opt-out only when asked, and forwards fetch options", async () => {
  const calls: unknown[][] = [];
  const stub: Stub = {
    check: (...a) => {
      calls.push(["check", ...a]);
      return Promise.resolve({
        available: true,
        version: "2.0.0",
        currentVersion: "1.0.0",
        required: true,
        releaseNotes: null,
        publishedAt: "t",
        size: 5,
      });
    },
    download: (...a) => {
      calls.push(["download", ...a]);
      return Promise.resolve({ version: "2.0.0", size: 5 });
    },
    stage: (...a) => {
      calls.push(["stage", ...a]);
      return Promise.resolve({ version: "2.0.0", signature: { mode: "team", identity: "TEAM1" } });
    },
    applyAndRelaunch: (...a) => {
      calls.push(["apply", ...a]);
      return { quitting: true };
    },
    confirm: () => true,
  };
  await withRuntime(stub, async () => {
    const config = {
      manifestUrl: "https://x/a.json",
      caCerts: ["PEM"],
      allowInsecureLoopback: true,
    };
    const check = await checkForAppUpdate(config);
    assertEquals(check.required, true);
    const staged = await downloadAppUpdate(config);
    assertEquals(staged, { version: "2.0.0", signatureMode: "team", signer: "TEAM1" });
    await downloadAppUpdate({ ...config, allowUnsignedDev: true });
    assertEquals(installAppUpdateAndRelaunch({ force: true }), { quitting: true });
    assertEquals(confirmAppUpdate(), true);
  });
  assertEquals(calls[0], ["check", "https://x/a.json", {
    caCerts: ["PEM"],
    allowInsecureLoopback: true,
  }]);
  assertEquals(calls[1], ["download", { caCerts: ["PEM"], allowInsecureLoopback: true }]);
  assertEquals(calls[2], ["stage", {}]);
  assertEquals(calls[4], ["stage", { allowUnsignedDev: true }]);
  assertEquals(calls[5], ["apply", { force: true }]);
});

Deno.test("wrappers: progress, signal and timeout are forwarded only when given", async () => {
  const calls: unknown[][] = [];
  const onProgress = () => {};
  const signal = new AbortController().signal;
  await withRuntime({
    check: (...a) => {
      calls.push(a);
      return Promise.resolve({ available: false, version: "1.0.0", currentVersion: "1.0.0" });
    },
    download: (...a) => {
      calls.push(a);
      return Promise.resolve({ version: "2.0.0", size: 1 });
    },
    stage: () => Promise.resolve({ version: "2.0.0", signature: { mode: "none", identity: null } }),
    applyAndRelaunch: (...a) => {
      calls.push(a);
      return { quitting: false };
    },
  }, async () => {
    const check = await checkForAppUpdate({ manifestUrl: "https://x/a.json", timeoutMs: 0 });
    assertEquals(check.available, false);
    await downloadAppUpdate({ manifestUrl: "https://x/a.json" }, { onProgress, signal });
    // A refusing app reports quitting: false; without `force` the runtime gets no force flag.
    assertEquals(installAppUpdateAndRelaunch(), { quitting: false });
  });
  assertEquals(calls[0], ["https://x/a.json", { timeoutMs: 0 }]);
  assertEquals(calls[1], [{ onProgress, signal }]);
  assertEquals(calls[2], [{}]);
});

Deno.test("wrappers: install / confirm / stage failures rethrow as AppUpdateError; status reads through", async () => {
  await withRuntime({
    stage: () => Promise.reject(runtimeError("integrity", "hash mismatch")),
    download: () => Promise.resolve({ version: "2.0.0", size: 1 }),
    applyAndRelaunch: () => {
      throw runtimeError("not_staged", "nothing staged");
    },
    confirm: () => {
      // Not an Error and no code: the message is the stringified value, the code `io`.
      throw "disk on fire";
    },
    status: () => ({ configured: true, reason: null, version: "2.0.0", trial: true }),
  }, async () => {
    const staged = await assertRejects(
      () => downloadAppUpdate({ manifestUrl: "https://x/a.json" }),
      AppUpdateError,
    );
    assertEquals(staged.code, "integrity");
    const install = assertThrows(() => installAppUpdateAndRelaunch(), AppUpdateError);
    assertEquals(install.code, "not_staged");
    assertEquals(install.message, "nothing staged");
    const confirm = assertThrows(() => confirmAppUpdate(), AppUpdateError);
    assertEquals(confirm.code, "io");
    assertEquals(confirm.message, "disk on fire");
    assertEquals(appUpdateStatus()?.version, "2.0.0");
    assertEquals(appUpdateStatus()?.trial, true);
  });
  // A runtime whose status() answers nothing is reported as null, never undefined.
  await withRuntime({ status: () => undefined }, () => {
    assertEquals(appUpdateStatus(), null);
    return Promise.resolve();
  });
  // A thrown null still becomes a typed error.
  await withRuntime({ check: () => Promise.reject(null) }, async () => {
    const e = await assertRejects(
      () => checkForAppUpdate({ manifestUrl: "https://x/a.json" }),
      AppUpdateError,
    );
    assertEquals([e.code, e.message], ["io", "null"]);
  });
});
