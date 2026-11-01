// Per-OS app-directory resolution (`src/desktop/app-dirs.ts`) — the layout the `fs`/`sqlite`
// capabilities and the desktop updater (`<data>/ui-updates`) both build on. The `os` parameter lets
// one machine assert every OS's paths; the updater's dir is pinned so the shared-helper refactor
// (extracting env/homeDir/osDataDir out of updater.ts) keeps installed apps' paths byte-identical.

import { assertEquals, assertNotEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { desktopAppDirs, env, osDataDir } from "../src/desktop/app-dirs.ts";

const APP = "com.example.app";
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_DOCUMENTS_DIR",
];

/** Run `fn` with a controlled environment, restoring every touched key afterward. */
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, Deno.env.get(k));
  try {
    for (const k of ENV_KEYS) Deno.env.delete(k);
    for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
    fn();
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

/** The updater's data dir is `<osDataDir>/ui-updates` — pinned so the refactor stays byte-identical. */
function updaterDir(os: "darwin" | "windows" | "linux"): string {
  return join(osDataDir(APP, os), "ui-updates");
}

Deno.test("app-dirs macOS: data/cache/documents and the updater dir", () => {
  const home = "/Users/tester";
  withEnv({ HOME: home }, () => {
    assertEquals(osDataDir(APP, "darwin"), join(home, "Library", "Application Support", APP));
    assertEquals(desktopAppDirs(APP, "darwin"), {
      data: join(home, "Library", "Application Support", APP),
      cache: join(home, "Library", "Caches", APP, "denext"),
      documents: join(home, "Documents", APP),
    });
    assertEquals(
      updaterDir("darwin"),
      join(home, "Library", "Application Support", APP, "ui-updates"),
    );
  });
});

Deno.test("app-dirs Windows: %APPDATA%/%LOCALAPPDATA% and the updater dir", () => {
  const home = "C:/Users/tester";
  const appData = "C:/Users/tester/AppData/Roaming";
  const localAppData = "C:/Users/tester/AppData/Local";
  withEnv({ USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData }, () => {
    assertEquals(osDataDir(APP, "windows"), join(appData, APP));
    assertEquals(desktopAppDirs(APP, "windows"), {
      data: join(appData, APP),
      cache: join(localAppData, APP, "Cache"),
      documents: join(home, "Documents", APP),
    });
    assertEquals(updaterDir("windows"), join(appData, APP, "ui-updates"));
  });
  // Fallback when APPDATA is unset: ~/AppData/Roaming.
  withEnv({ USERPROFILE: home }, () => {
    assertEquals(osDataDir(APP, "windows"), join(home, "AppData", "Roaming", APP));
  });
});

Deno.test("app-dirs Linux: XDG dirs (and their ~ fallbacks) and the updater dir", () => {
  const home = "/home/tester";
  withEnv({
    HOME: home,
    XDG_DATA_HOME: "/home/tester/.xdgdata",
    XDG_CACHE_HOME: "/home/tester/.xdgcache",
  }, () => {
    assertEquals(osDataDir(APP, "linux"), join("/home/tester/.xdgdata", APP));
    assertEquals(desktopAppDirs(APP, "linux"), {
      data: join("/home/tester/.xdgdata", APP),
      cache: join("/home/tester/.xdgcache", APP, "denext"),
      documents: join(home, "Documents", APP),
    });
    assertEquals(updaterDir("linux"), join("/home/tester/.xdgdata", APP, "ui-updates"));
  });
  // Fallbacks when the XDG vars are unset.
  withEnv({ HOME: home }, () => {
    assertEquals(desktopAppDirs(APP, "linux"), {
      data: join(home, ".local", "share", APP),
      cache: join(home, ".cache", APP, "denext"),
      documents: join(home, "Documents", APP),
    });
    assertEquals(updaterDir("linux"), join(home, ".local", "share", APP, "ui-updates"));
  });
});

Deno.test("app-dirs: the cache root is a folder of its own, never the engine's cache folder", () => {
  // The web engines keep their caches in the OS cache folder keyed by the app id
  // (~/Library/Caches/<id>/CEF and /WebKit on macOS, ~/.cache/<id>/WebKitCache on Linux), so the
  // page's `directory: "cache"` is a sub-folder: listing it can't reach theirs.
  const home = "/home/tester";
  withEnv({ HOME: home }, () => {
    for (const os of ["darwin", "linux", "windows"] as const) {
      const cache = desktopAppDirs(APP, os).cache;
      const engineFolder = os === "darwin"
        ? join(home, "Library", "Caches", APP)
        : os === "linux"
        ? join(home, ".cache", APP)
        : join(home, "AppData", "Local", APP);
      assertEquals(dirname(cache), engineFolder, os);
      assertNotEquals(cache, engineFolder, os);
    }
  });
});

Deno.test("app-dirs: empty / whitespace-only env values count as unset", () => {
  const home = "C:/Users/tester";
  for (const blank of ["", "   "]) {
    withEnv({ USERPROFILE: home, APPDATA: blank }, () => {
      assertEquals(osDataDir(APP, "windows"), join(home, "AppData", "Roaming", APP));
    });
    withEnv({ USERPROFILE: home, APPDATA: blank, LOCALAPPDATA: blank }, () => {
      assertEquals(
        desktopAppDirs(APP, "windows").cache,
        join(home, "AppData", "Local", APP, "Cache"),
      );
    });
    withEnv({ HOME: "/home/t", XDG_DATA_HOME: blank }, () => {
      assertEquals(osDataDir(APP, "linux"), join("/home/t", ".local", "share", APP));
    });
    // HOME blank falls through to USERPROFILE, not a relative path.
    withEnv({ HOME: blank, USERPROFILE: home }, () => {
      assertEquals(osDataDir(APP, "darwin"), join(home, "Library", "Application Support", APP));
    });
  }
});

Deno.test("app-dirs: macOS ignores XDG_DATA_HOME; env() has no lowercase fallback", () => {
  withEnv({ HOME: "/Users/t", XDG_DATA_HOME: "/x" }, () => {
    assertEquals(osDataDir(APP, "darwin"), join("/Users/t", "Library", "Application Support", APP));
  });
  const key = "DENEXT_TEST_CASE_ONLY";
  Deno.env.set(key.toLowerCase(), "v");
  try {
    if (Deno.build.os !== "windows") assertEquals(env(key), undefined);
  } finally {
    Deno.env.delete(key.toLowerCase());
  }
});
