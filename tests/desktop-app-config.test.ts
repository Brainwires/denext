// The desktop packager's per-app files (src/build/desktop-app-config.ts): `.deno-desktop/app.json`
// + deno.json `compile.include` (idempotent, never clobbering other includes or comments), the
// packaged `laufey-launch.json` per OS, the `LAUFEY_*` env for an unpackaged window, and the
// `denext doctor` check over them.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  DESKTOP_APP_CONFIG_FILE,
  desktopAppIdentity,
  desktopInspectable,
  desktopLaunchConfig,
  laufeyLaunchEnv,
  laufeyLaunchPath,
  syncDesktopAppConfig,
  syncDesktopAppConfigAt,
  unpackagedLaunchEnv,
  writeLaufeyLaunchConfig,
} from "../src/build/desktop-app-config.ts";
import { desktopOriginCheck } from "../src/cli/commands/doctor.ts";

const T3 = { desktop: { app: { origin: "T3Code://App/", identifier: "com.t3.code" } } };

async function project(denoJson?: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-desktop-app-config-" });
  if (denoJson !== undefined) await Deno.writeTextFile(join(dir, "deno.json"), denoJson);
  return dir;
}

Deno.test("desktopAppIdentity: normalized origin + identifier; null without an origin", () => {
  assertEquals(desktopAppIdentity(T3), { origin: "t3code://app", identifier: "com.t3.code" });
  assertEquals(desktopAppIdentity({ desktop: { app: { identifier: "com.t3.code" } } }), null);
  assertEquals(desktopAppIdentity(undefined), null);
  let err = "";
  try {
    desktopAppIdentity({ desktop: { app: { origin: "t3code://app" } } });
  } catch (e) {
    err = String(e);
  }
  assertStringIncludes(err, "requires desktop.app.identifier");
});

Deno.test("desktopLaunchConfig: appId, the ORIGIN's scheme (not app, not deep links), singleInstance", () => {
  assertEquals(desktopLaunchConfig(T3), { appId: "com.t3.code", customSchemes: ["t3code"] });
  assertEquals(
    desktopLaunchConfig({
      desktop: {
        app: {
          origin: "t3code://app",
          identifier: "com.t3.code",
          deepLinks: ["t3code-auth"],
          singleInstance: true,
        },
      },
    }),
    { appId: "com.t3.code", customSchemes: ["t3code"], singleInstance: true },
  );
  // The built-in `app` scheme needs no registration.
  assertEquals(
    desktopLaunchConfig({ desktop: { app: { origin: "app://localhost", identifier: "a.b" } } }),
    { appId: "a.b" },
  );
  // An identifier alone still gives CEF a persistent store.
  assertEquals(desktopLaunchConfig({ desktop: { app: { identifier: "com.acme.x" } } }), {
    appId: "com.acme.x",
  });
  assertEquals(desktopLaunchConfig({ desktop: { app: { identifier: "../x" } } }), null);
  assertEquals(desktopLaunchConfig({}), null);
});

Deno.test("laufeyLaunchPath: Contents/Resources on macOS, next to the exe elsewhere", () => {
  assertEquals(
    laufeyLaunchPath("darwin", "dist/T3.app"),
    join("dist/T3.app", "Contents", "Resources", "laufey-launch.json"),
  );
  assertEquals(
    laufeyLaunchPath("windows", "dist/t3-x64"),
    join("dist/t3-x64", "laufey-launch.json"),
  );
  assertEquals(laufeyLaunchPath("linux", "dist/t3-x64"), join("dist/t3-x64", "laufey-launch.json"));
});

Deno.test("laufeyLaunchEnv: the LAUFEY_* overrides for an unpackaged window", () => {
  assertEquals(
    laufeyLaunchEnv({ appId: "a.b", customSchemes: ["x", "y"], singleInstance: false }),
    {
      LAUFEY_APP_ID: "a.b",
      LAUFEY_CUSTOM_SCHEMES: "x,y",
      LAUFEY_SINGLE_INSTANCE: "0",
    },
  );
  assertEquals(laufeyLaunchEnv(null), {});
  assertEquals(laufeyLaunchEnv({ inspectable: false }), { LAUFEY_INSPECTABLE: "0" });
  assertEquals(laufeyLaunchEnv({ inspectable: true }), { LAUFEY_INSPECTABLE: "1" });
});

Deno.test("unpackagedLaunchEnv: app id, the origin's scheme and DevTools — never single instance", () => {
  const config = {
    desktop: {
      app: { origin: "t3code://app", identifier: "com.t3.code", singleInstance: true },
      inspectable: false,
    },
  };
  assertEquals(unpackagedLaunchEnv(config, "dev"), {
    LAUFEY_APP_ID: "com.t3.code",
    LAUFEY_CUSTOM_SCHEMES: "t3code",
    LAUFEY_INSPECTABLE: "1",
  });
  assertEquals(unpackagedLaunchEnv(config, "run").LAUFEY_INSPECTABLE, "0");
  assertEquals(unpackagedLaunchEnv({}, "run"), { LAUFEY_INSPECTABLE: "1" });
});

Deno.test("desktopInspectable: always in dev, default on in run, default OFF when packaged", () => {
  const on = { desktop: { inspectable: true } };
  const off = { desktop: { inspectable: false } };
  assertEquals(desktopInspectable({}, "dev"), true);
  assertEquals(desktopInspectable(off, "dev"), true);
  assertEquals(desktopInspectable({}, "run"), true);
  assertEquals(desktopInspectable(off, "run"), false);
  assertEquals(desktopInspectable({}, "package"), false);
  assertEquals(desktopInspectable(undefined, "package"), false);
  assertEquals(desktopInspectable(on, "package"), true);
});

Deno.test("sync: writes app.json and appends to compile.include, keeping comments + entries", async () => {
  const dir = await project(
    '{\n  // keep me\n  "compile": { "include": ["out", "assets/"] },\n  "tasks": {}\n}\n',
  );
  try {
    assertEquals(await syncDesktopAppConfigAt(dir, T3), {
      appJson: "written",
      include: "updated",
      identity: "updated",
    });
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE))),
      { origin: "t3code://app", identifier: "com.t3.code" },
    );
    const deno = await Deno.readTextFile(join(dir, "deno.json"));
    assertStringIncludes(deno, "// keep me");
    assertStringIncludes(deno, '"out", "assets/", ".deno-desktop/app.json"');
    // The identifier is mirrored into deno.json's desktop.app (what `deno desktop` reads).
    assertEquals(JSON.parse(deno.replace("// keep me", "")).desktop, {
      app: { identifier: "com.t3.code" },
    });
    // Idempotent: a second run changes nothing.
    assertEquals(await syncDesktopAppConfigAt(dir, T3), {
      appJson: "unchanged",
      include: "unchanged",
      identity: "unchanged",
    });
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), deno);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sync: creates compile.include when absent; a ./ spelling counts as present", async () => {
  const bare = await project('{ "tasks": {} }\n');
  const dotted = await project('{ "compile": { "include": ["./.deno-desktop/app.json"] } }\n');
  try {
    assertEquals((await syncDesktopAppConfigAt(bare, T3)).include, "updated");
    const deno = JSON.parse(await Deno.readTextFile(join(bare, "deno.json")));
    assertEquals(deno.compile.include, [DESKTOP_APP_CONFIG_FILE]);
    assertEquals((await syncDesktopAppConfigAt(dotted, T3)).include, "unchanged");
  } finally {
    await Deno.remove(bare, { recursive: true });
    await Deno.remove(dotted, { recursive: true });
  }
});

Deno.test("sync: removing the origin removes app.json and only its include entry", async () => {
  const dir = await project('{ "compile": { "include": ["out"] } }\n');
  const lone = await project("{}\n");
  try {
    await syncDesktopAppConfigAt(dir, T3);
    const none = { desktop: { app: { identifier: "com.t3.code" } } };
    assertEquals(await syncDesktopAppConfigAt(dir, none), {
      appJson: "removed",
      include: "updated",
      identity: "unchanged",
    });
    await assertRejects(() => Deno.stat(join(dir, DESKTOP_APP_CONFIG_FILE)), Deno.errors.NotFound);
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).compile.include, [
      "out",
    ]);
    // A compile block that held only our entry goes away entirely.
    await syncDesktopAppConfigAt(lone, T3);
    await syncDesktopAppConfigAt(lone, none);
    assertEquals(JSON.parse(await Deno.readTextFile(join(lone, "deno.json"))), {
      desktop: { app: { identifier: "com.t3.code" } },
    });
    // No origin and nothing written before: a no-op.
    assertEquals(await syncDesktopAppConfigAt(lone, none), {
      appJson: "none",
      include: "unchanged",
      identity: "unchanged",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(lone, { recursive: true });
  }
});

/**
 * Point `path` at the directory `target` with a link. A symlink where this process may create one;
 * on Windows without that privilege (a standard user without Developer Mode: os error 1314) a
 * directory junction, which needs none and which `Deno.lstat` reports as a symlink too — so the
 * refusal is asserted for every user, not skipped.
 */
async function linkDir(target: string, path: string): Promise<void> {
  try {
    await Deno.symlink(target, path, { type: "dir" });
  } catch (err) {
    if (Deno.build.os !== "windows" || !/os error 1314\b/.test(String(err))) throw err;
    await Deno.symlink(target, path, { type: "junction" });
  }
}

Deno.test("sync: a non-array compile.include and a symlinked .deno-desktop are refused", async () => {
  const odd = await project('{ "compile": { "include": "out" } }\n');
  const linked = await project("{}\n");
  const elsewhere = await Deno.makeTempDir();
  try {
    await assertRejects(() => syncDesktopAppConfigAt(odd, T3), Error, "must be an array");
    await linkDir(elsewhere, join(linked, ".deno-desktop"));
    await assertRejects(() => syncDesktopAppConfigAt(linked, T3), Error, "symlink");
  } finally {
    for (const d of [odd, linked, elsewhere]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("sync + launch file: driven from a package script's import.meta.url", async () => {
  const dir = await project("{}\n");
  try {
    await Deno.mkdir(join(dir, "scripts"));
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { desktop: { app: { origin: 't3code://app', identifier: 'com.t3.code', " +
        "singleInstance: true } } };\n",
    );
    const entry = toFileUrl(join(dir, "scripts", "package-macos.ts")).href;
    assertEquals((await syncDesktopAppConfig(entry)).appJson, "written");
    const app = join(dir, "dist", "T3.app");
    const written = await writeLaufeyLaunchConfig(entry, "darwin", app);
    assertEquals(written, join(app, "Contents", "Resources", "laufey-launch.json"));
    assertEquals(JSON.parse(await Deno.readTextFile(written!)), {
      appId: "com.t3.code",
      customSchemes: ["t3code"],
      singleInstance: true,
      inspectable: false,
    });
    const linux = join(dir, "dist", "t3-x64");
    await Deno.mkdir(linux, { recursive: true });
    assertEquals(
      await writeLaufeyLaunchConfig(entry, "linux", linux),
      join(linux, "laufey-launch.json"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("launch file: without a config it still turns DevTools off", async () => {
  const dir = await project();
  try {
    await Deno.mkdir(join(dir, "scripts"));
    const entry = toFileUrl(join(dir, "scripts", "package-linux.ts")).href;
    const written = await writeLaufeyLaunchConfig(entry, "linux", join(dir, "dist"));
    assertEquals(written, join(dir, "dist", "laufey-launch.json"));
    assertEquals(JSON.parse(await Deno.readTextFile(written!)), { inspectable: false });
    assertEquals(await syncDesktopAppConfig(entry), { appJson: "none", include: "no-deno-json" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor: the desktop app-origin check flags missing/stale files and passes once synced", async () => {
  const dir = await project('{ "desktop": { "app": { "identifier": "com.other.id" } } }\n');
  try {
    assertEquals(await desktopOriginCheck(dir, { desktop: {} }), null);
    const before = await desktopOriginCheck(dir, T3);
    assert(before && !before.ok && !before.critical);
    assertStringIncludes(before.detail, "app.json is missing");
    assertStringIncludes(before.detail, "compile.include does not list");
    assertStringIncludes(before.detail, '"com.other.id" differs');
    await syncDesktopAppConfigAt(dir, T3);
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      (await Deno.readTextFile(join(dir, "deno.json"))).replace("com.other.id", "com.t3.code"),
    );
    const after = await desktopOriginCheck(dir, T3);
    assert(after?.ok, after?.detail);
    assertStringIncludes(after.detail, "t3code://app");
    const bad = await desktopOriginCheck(dir, { desktop: { app: { origin: "https://x" } } });
    assert(bad && !bad.ok);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sync: deepLinks + singleInstance go to app.json, and deepLinks to deno.json", async () => {
  const dir = await project('{\n  // keep\n  "desktop": { "app": { "name": "T3" } }\n}\n');
  const config = {
    desktop: {
      app: { ...T3.desktop.app, deepLinks: ["T3Code", "t3code-dev"], singleInstance: true },
    },
  };
  try {
    assertEquals(await syncDesktopAppConfigAt(dir, config), {
      appJson: "written",
      include: "updated",
      deepLinks: "updated",
      identity: "updated",
    });
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE))), {
      origin: "t3code://app",
      identifier: "com.t3.code",
      deepLinks: ["t3code", "t3code-dev"],
      singleInstance: true,
    });
    const deno = await Deno.readTextFile(join(dir, "deno.json"));
    assertStringIncludes(deno, "// keep");
    assertEquals(JSON.parse(deno.replace("// keep", "")).desktop.app, {
      name: "T3",
      deepLinks: ["t3code", "t3code-dev"],
      identifier: "com.t3.code",
    });
    assertEquals((await syncDesktopAppConfigAt(dir, config)).deepLinks, "unchanged");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sync: deep links without an origin still write app.json (no origin key)", async () => {
  const dir = await project("{}\n");
  try {
    const config = { desktop: { app: { identifier: "com.a.b", deepLinks: ["myapp"] } } };
    assertEquals((await syncDesktopAppConfigAt(dir, config)).appJson, "written");
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE))), {
      identifier: "com.a.b",
      deepLinks: ["myapp"],
    });
    // singleInstance without a valid identifier is not recorded (the runtime requires one).
    const noId = { desktop: { app: { deepLinks: ["myapp"], singleInstance: true } } };
    await syncDesktopAppConfigAt(dir, noId);
    assertEquals(JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_APP_CONFIG_FILE))), {
      deepLinks: ["myapp"],
    });
    // An invalid scheme fails like the runtime would.
    await assertRejects(
      () => syncDesktopAppConfigAt(dir, { desktop: { app: { deepLinks: ["http"] } } }),
      Error,
      "deepLinks",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
