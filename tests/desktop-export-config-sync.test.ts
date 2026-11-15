// A desktop app's `.deno-desktop/config.json` (the runtime slice of `denext.config.ts` its
// `desktop.ts` imports) is rewritten by every export, App Router and Pages Router apps included,
// not only SPA mode's: `denext desktop build` is an export, and a bare `deno desktop` after it
// embeds whatever that file holds. Before, an App Router export (what `denext create --desktop`
// scaffolds) left the file as it was, so a capability added to the config never reached the app
// until `denext desktop run` / `dev` or a package script synced it, while the scaffold's
// `desktop.ts` said every export and build rewrote it.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  DESKTOP_RUNTIME_CONFIG_FILE,
  desktopRuntimeConfigText,
  syncDesktopAfterExport,
} from "../src/build/desktop-app-config.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import { exportInChild } from "./helpers/bounded-build.ts";
import { removeTempDir } from "./helpers/temp.ts";

/** The scaffolded desktop entry (it imports `.deno-desktop/config.json`). */
const ENTRY =
  scaffoldFiles({ dir: "/x", desktop: true }).find((f) => f.path === "desktop.ts")!.content;

/** The `desktop` section of a project's `.deno-desktop/config.json`. */
async function runtimeDesktop(dir: string): Promise<Record<string, unknown>> {
  const text = await Deno.readTextFile(join(dir, DESKTOP_RUNTIME_CONFIG_FILE));
  return JSON.parse(text).desktop ?? {};
}

Deno.test("syncDesktopAfterExport: a desktop app's runtime config follows the config; others are left alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_export_sync_" });
  try {
    const config = { desktop: { capabilities: { device: true } } };
    assertEquals(
      await syncDesktopAfterExport(dir, config),
      null,
      "no desktop.ts: not a desktop app",
    );
    assert(!(await Deno.stat(join(dir, ".deno-desktop")).then(() => true, () => false)));
    await Deno.writeTextFile(join(dir, "desktop.ts"), ENTRY);
    await Deno.mkdir(join(dir, ".deno-desktop"));
    await Deno.writeTextFile(join(dir, DESKTOP_RUNTIME_CONFIG_FILE), "{}\n");
    const report = await syncDesktopAfterExport(dir, config);
    assertEquals(report?.runtimeConfig, "written");
    assertEquals(await runtimeDesktop(dir), config.desktop);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("an App Router export of a desktop app rewrites .deno-desktop/config.json from the config", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_export_app_" });
  try {
    const root = new URL("../", import.meta.url).href;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": `${root}mod.ts`,
          "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
          "denext/server": `${root}src/server/mod.ts`,
          "denext/client": `${root}src/client/mod.ts`,
          "denext/desktop": `${root}src/build/desktop.ts`,
        },
      }),
    );
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      "export default function Page() { return <main>desktop</main>; }\n",
    );
    const desktop = { capabilities: { device: true, keepAwake: true } };
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default ${JSON.stringify({ desktop })};\n`,
    );
    await Deno.writeTextFile(join(dir, "desktop.ts"), ENTRY);
    // The copy the scaffold committed: the config has moved on since.
    await Deno.mkdir(join(dir, ".deno-desktop"));
    await Deno.writeTextFile(
      join(dir, DESKTOP_RUNTIME_CONFIG_FILE),
      desktopRuntimeConfigText({ desktop: { capabilities: {} } }),
    );
    const result = await exportInChild(dir);
    assert(await Deno.stat(join(result.outDir, "index.html")).then(() => true, () => false));
    assertEquals(await runtimeDesktop(dir), desktop);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("the scaffolded desktop.ts names the flows that rewrite its config, not `denext build`", () => {
  assert(!ENTRY.includes("every export, build"), "denext build does not rewrite it");
  assert(ENTRY.includes("`denext desktop build`"));
  assert(ENTRY.includes("not by `denext build`"));
});
