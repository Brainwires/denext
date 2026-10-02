// The package scripts take the app's name, identifier and icon from `denext.config.ts`
// `desktop.app` (falling back to deno.json's): the name for artifacts and the bundle, the identifier
// mirrored into deno.json (what `deno desktop` reads), and `--icon` from `desktop.app.icons.<os>`
// on every OS — the macOS script passed none before.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  desktopAppName,
  desktopBundleCommand,
  desktopIconArgs,
} from "../src/build/desktop-package-script.ts";
import { syncDesktopAppConfigAt } from "../src/build/desktop-app-config.ts";
import { packageMetaFrom } from "../src/build/desktop-installers.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";

/** A temp project: `deno.json`, an optional `denext.config.ts`, and files (path → content). */
async function project(
  denoJson: unknown,
  config?: unknown,
  files: Record<string, string> = {},
): Promise<{ dir: string; entry: string }> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "scripts"));
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify(denoJson, null, 2) + "\n");
  if (config !== undefined) {
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default ${JSON.stringify(config)};\n`,
    );
  }
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return { dir, entry: toFileUrl(join(dir, "scripts", "package-macos.ts")).href };
}

/** Run `fn` without `DENEXT_APP_NAME`, restoring it. */
async function withoutAppNameEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("DENEXT_APP_NAME");
  Deno.env.delete("DENEXT_APP_NAME");
  try {
    return await fn();
  } finally {
    if (prev !== undefined) Deno.env.set("DENEXT_APP_NAME", prev);
  }
}

Deno.test("desktopAppName: DENEXT_APP_NAME, then denext.config.ts, then deno.json", async () => {
  const both = await project(
    { desktop: { app: { name: "From Deno" } } },
    { desktop: { app: { name: "From Config" } } },
  );
  const denoOnly = await project({ desktop: { app: { name: "From Deno" } } });
  const none = await project({});
  try {
    await withoutAppNameEnv(async () => {
      assertEquals(await desktopAppName(both.entry), "From Config");
      assertEquals(await desktopAppName(denoOnly.entry), "From Deno");
      assertEquals(await desktopAppName(none.entry), "app");
    });
    const prev = Deno.env.get("DENEXT_APP_NAME");
    Deno.env.set("DENEXT_APP_NAME", "From Env");
    try {
      assertEquals(await desktopAppName(both.entry), "From Env");
    } finally {
      if (prev === undefined) Deno.env.delete("DENEXT_APP_NAME");
      else Deno.env.set("DENEXT_APP_NAME", prev);
    }
  } finally {
    for (const p of [both, denoOnly, none]) await Deno.remove(p.dir, { recursive: true });
  }
});

Deno.test("sync: desktop.app name + identifier from the config are mirrored into deno.json", async () => {
  const { dir } = await project(
    { desktop: { app: { name: "Old", identifier: "com.old.app" } } },
  );
  const config = { desktop: { app: { name: "New App", identifier: "com.new.app" } } };
  try {
    assertEquals((await syncDesktopAppConfigAt(dir, config)).identity, "updated");
    const app = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).desktop.app;
    assertEquals([app.name, app.identifier], ["New App", "com.new.app"]);
    assertEquals((await syncDesktopAppConfigAt(dir, config)).identity, "unchanged");
    // Nothing configured: deno.json's own values stay, and nothing is reported.
    assertEquals((await syncDesktopAppConfigAt(dir, {})).identity, undefined);
    // An invalid identifier is never mirrored (validation reports it).
    await syncDesktopAppConfigAt(dir, { desktop: { app: { identifier: "no dots" } } });
    const after = JSON.parse(await Deno.readTextFile(join(dir, "deno.json"))).desktop.app;
    assertEquals(after.identifier, "com.new.app");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("packageMetaFrom: the config's name and identifier come before deno.json's", () => {
  const meta = packageMetaFrom(
    { desktop: { app: { name: "Deno Name", identifier: "com.deno.name" } } },
    { desktop: { app: { name: "Config Name", identifier: "com.config.name" } } },
    "fallback",
  );
  assertEquals([meta.name, meta.identifier], ["Config Name", "com.config.name"]);
  const denoOnly = packageMetaFrom(
    { desktop: { app: { name: "Deno Name", identifier: "com.deno.name" } } },
    {},
    "fallback",
  );
  assertEquals([denoOnly.name, denoOnly.identifier], ["Deno Name", "com.deno.name"]);
});

Deno.test("desktopIconArgs: config icon, then deno.json's, then the OS's default files", async () => {
  const files = {
    "art/mac.icns": "icns",
    "art/deno.icns": "icns",
    "icons/app.icns": "icns",
    "icons/app.ico": "ico",
    "icons/app.png": "png",
  };
  const configured = await project(
    { desktop: { app: { icons: { macos: "art/deno.icns" } } } },
    { desktop: { app: { icons: { macos: "art/mac.icns" } } } },
    files,
  );
  const denoOnly = await project({ desktop: { app: { icons: { macos: "art/deno.icns" } } } }, {
    desktop: {},
  }, files);
  const defaults = await project({}, undefined, files);
  const bare = await project({});
  try {
    assertEquals(await desktopIconArgs(configured.entry, "darwin"), ["--icon", "art/mac.icns"]);
    assertEquals(await desktopIconArgs(denoOnly.entry, "darwin"), ["--icon", "art/deno.icns"]);
    assertEquals(await desktopIconArgs(defaults.entry, "darwin"), ["--icon", "icons/app.icns"]);
    assertEquals(await desktopIconArgs(defaults.entry, "windows"), ["--icon", "icons/app.ico"]);
    assertEquals(await desktopIconArgs(defaults.entry, "linux"), ["--icon", "icons/app.png"]);
    // Another OS's key does not apply.
    assertEquals(await desktopIconArgs(configured.entry, "linux"), ["--icon", "icons/app.png"]);
    assertEquals(await desktopIconArgs(bare.entry, "darwin"), []);
  } finally {
    for (const p of [configured, denoOnly, defaults, bare]) {
      await Deno.remove(p.dir, { recursive: true });
    }
  }
});

Deno.test("desktopIconArgs: a configured icon that does not exist fails the build", async () => {
  const { dir, entry } = await project({}, { desktop: { app: { icons: { linux: "nope.png" } } } });
  try {
    await assertRejects(
      () => desktopIconArgs(entry, "linux"),
      Error,
      "desktop.app.icons.linux: no file at nope.png",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundle command (Linux / Windows): the configured icon beats the script's candidates", async () => {
  const { dir, entry } = await project(
    {},
    { desktop: { app: { icons: { windows: "brand/app.ico" } } } },
    { "brand/app.ico": "ico", "icons/app.ico": "ico" },
  );
  const cwd = Deno.cwd();
  try {
    Deno.chdir(dir);
    const cmd = await desktopBundleCommand(entry, "windows", {
      target: "x86_64-pc-windows-msvc",
      out: "dist/a-x64",
      icons: ["icons/app.ico"],
    });
    assertStringIncludes(cmd.join(" "), "--icon brand/app.ico --output dist/a-x64 desktop.ts");
  } finally {
    Deno.chdir(cwd);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scaffold: the macOS script passes --icon and names the app from the config", () => {
  const mac =
    scaffoldFiles({ dir: ".", desktop: true }).find((f) => f.path === "scripts/package-macos.ts")!
      .content;
  assertStringIncludes(mac, 'cmd.push(...await desktopIconArgs(import.meta.url, "darwin"));');
  assertStringIncludes(mac, "await appName(import.meta.url)");
});

Deno.test("config validation: desktop.app.name and desktop.app.icons", () => {
  const check = (app: unknown) => () =>
    validateDenextConfig({ desktop: { app } } as unknown as DenextConfig);
  check({ name: "My App", icons: { macos: "icons/app.icns", windows: "icons/app.ico" } })();
  assertThrows(check({ name: "" }), Error, "desktop.app.name");
  assertThrows(check({ icons: "icons/app.png" }), Error, "desktop.app.icons");
  assertThrows(check({ icons: { ios: "x.png" } }), Error, "desktop.app.icons.ios");
  assertThrows(check({ icons: { linux: 3 } }), Error, "desktop.app.icons.linux");
});
