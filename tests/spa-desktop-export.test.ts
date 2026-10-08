// `denext export` of a SPA desktop app (a `desktop.ts` entry) prepares what the migrated
// `deno task desktop` — `export && deno desktop … desktop.ts` — needs: the app icon, and the
// app's name/identifier from `desktop.app` in denext.config.ts copied into deno.json, which is
// where a bare `deno desktop` reads them. Without the copy a migrated T3 Code got
// `com.deno.desktop.t3-code` whatever the config said — the identity of every other T3 Code
// build on the machine (shared WebKit storage, LaunchServices).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { prepareDesktopExport } from "../src/build/spa/build.ts";
import type { DenextConfig } from "../src/server/config.ts";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_desktop_export_" });
  for (const [rel, body] of Object.entries(files)) await Deno.writeTextFile(join(dir, rel), body);
  return dir;
}

const readDenoJson = async (dir: string) =>
  JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));

Deno.test("prepareDesktopExport: desktop.app name/identifier reach deno.json for deno desktop", async () => {
  const dir = await project({
    "deno.json": JSON.stringify({ tasks: { export: "denext export ." } }, null, 2),
    "desktop.ts": "// entry\n",
  });
  try {
    const config = {
      mode: "spa",
      spa: { entry: "./src/main.tsx" },
      desktop: { app: { name: "T3 Code Fresh", identifier: "com.example.fresh" } },
    } as DenextConfig;
    await prepareDesktopExport(dir, config);
    const deno = await readDenoJson(dir);
    assertEquals(deno.desktop?.app?.name, "T3 Code Fresh");
    assertEquals(deno.desktop?.app?.identifier, "com.example.fresh");
    assertEquals(deno.tasks.export, "denext export ."); // the rest is kept
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prepareDesktopExport: a SPA with no desktop entry leaves deno.json alone", async () => {
  const before = JSON.stringify({ tasks: {} }, null, 2);
  const dir = await project({ "deno.json": before });
  try {
    const config = {
      mode: "spa",
      spa: { entry: "./src/main.tsx" },
      desktop: { app: { name: "Web Only" } },
    } as DenextConfig;
    await prepareDesktopExport(dir, config);
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
