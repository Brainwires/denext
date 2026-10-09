// The desktop entry reads its config from `.deno-desktop/config.json`, not `denext.config.ts`.
//
// `desktop.ts` used to `import config from "./denext.config.ts"`, so `deno desktop` compiled the
// whole config module graph into the app: every plugin the config imports (and everything those
// import: esbuild, the build pipeline) shipped in the desktop binary. The sync step every desktop
// flow already runs (export / build, `denext desktop run|dev`, the package scripts) now also
// writes the serializable runtime slice the entry needs (`desktop` and `spa.proxy`), and the
// generated entries import that JSON.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { exists } from "@std/fs";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  DESKTOP_RUNTIME_CONFIG_FILE,
  syncDesktopAppConfigAt,
} from "../src/build/desktop-app-config.ts";
import { resolveDesktopCapabilities } from "../src/desktop/caps/mod.ts";
import { scaffoldFiles } from "../src/build/scaffold.ts";
import type { DenextConfig } from "../src/server/config.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** A config with a plugin (a live object with functions) beside the desktop runtime settings. */
function configWithPlugin(): DenextConfig {
  return {
    mode: "spa",
    plugins: [{ name: "build-only", setup() {} }],
    spa: {
      entry: "./src/main.tsx",
      proxy: { prefixes: ["/api"], target: "http://127.0.0.1:3773" },
    },
    desktop: {
      app: { name: "Runtime Config", identifier: "com.example.runtime-config" },
      capabilities: { device: true, shell: true },
      titleBar: "hiddenInset",
    },
  } as DenextConfig;
}

/** The scaffolded entry's text (it imports `.deno-desktop/config.json`). */
const ENTRY =
  scaffoldFiles({ dir: "/x", desktop: true }).find((f) => f.path === "desktop.ts")!.content;

Deno.test("sync writes the desktop entry's config: the desktop section and spa.proxy, no plugins", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
    await Deno.writeTextFile(join(dir, "desktop.ts"), ENTRY);
    const first = await syncDesktopAppConfigAt(dir, configWithPlugin());
    assertEquals(first.runtimeConfig, "written");
    const written = JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_RUNTIME_CONFIG_FILE)));
    assertEquals(written, {
      desktop: configWithPlugin().desktop,
      spa: { proxy: { prefixes: ["/api"], target: "http://127.0.0.1:3773" } },
    });
    assertEquals(
      (await syncDesktopAppConfigAt(dir, configWithPlugin())).runtimeConfig,
      "unchanged",
    );
    // No desktop section and no proxy: an empty object, still importable.
    await syncDesktopAppConfigAt(dir, {});
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, DESKTOP_RUNTIME_CONFIG_FILE))),
      {},
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sync leaves the project alone when its entry does not import the JSON", async () => {
  // An entry that imports denext.config.ts (or no entry: `denext desktop run` keeps the project
  // folder untouched) needs no config.json, and none is written.
  for (const entry of [undefined, `import config from "./denext.config.ts";\n`]) {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
      if (entry) await Deno.writeTextFile(join(dir, "desktop.ts"), entry);
      assertEquals((await syncDesktopAppConfigAt(dir, configWithPlugin())).runtimeConfig, "none");
      assertEquals(await exists(join(dir, ".deno-desktop")), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("resolveDesktopCapabilities reads the JSON as it reads the config, proxy included", async () => {
  const config = configWithPlugin();
  const json = JSON.parse(
    JSON.stringify({ desktop: config.desktop, spa: { proxy: config.spa!.proxy } }),
  );
  const fromConfig = await resolveDesktopCapabilities(config);
  const fromJson = await resolveDesktopCapabilities(json);
  assertEquals(
    fromJson.capabilities.map((c) => c.name).sort(),
    fromConfig.capabilities.map((c) => c.name).sort(),
  );
  assertEquals(fromJson.appSupportDir, fromConfig.appSupportDir);
  assertEquals(fromJson.window, fromConfig.window);
  assertEquals(fromJson.proxy, { prefixes: ["/api"], target: "http://127.0.0.1:3773" });
  assertEquals(fromConfig.proxy, fromJson.proxy, "the config form returns it too");
  assertEquals((await resolveDesktopCapabilities({})).proxy, undefined);
});

Deno.test("the scaffolded desktop entry imports the JSON, and the scaffold writes a first copy", () => {
  const files = scaffoldFiles({ dir: "/x", desktop: true });
  const entry = files.find((f) => f.path === "desktop.ts")!.content;
  assertStringIncludes(entry, `from "./${DESKTOP_RUNTIME_CONFIG_FILE}" with { type: "json" }`);
  assert(!entry.includes('denext.config.ts"'), "the entry no longer imports the config module");
  const json = files.find((f) => f.path === DESKTOP_RUNTIME_CONFIG_FILE);
  assert(json, "a first .deno-desktop/config.json so the entry type-checks before a build");
  assertEquals(JSON.parse(json!.content).desktop?.app?.identifier, "com.example.denext");
});

Deno.test({
  name: "the generated entry's module graph excludes denext.config.ts and the plugins it imports",
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir();
  try {
    // The repo's import map (made absolute) plus `denext/desktop`, as an app's would resolve it.
    const repoImports: Record<string, string> =
      JSON.parse(await Deno.readTextFile(join(REPO, "deno.json"))).imports;
    const imports = Object.fromEntries(
      Object.entries(repoImports).map((
        [k, v],
      ) => [
        k,
        v.startsWith("./") ? toFileUrl(join(REPO, v)).href + (v.endsWith("/") ? "/" : "") : v,
      ]),
    );
    imports["denext/desktop"] = toFileUrl(join(REPO, "src/build/desktop.ts")).href;
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports }));
    // The config imports a "plugin" module, as T3's imports its Vite emitter.
    await Deno.writeTextFile(join(dir, "heavy-plugin.ts"), "export const heavy = () => ({});\n");
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `import { heavy } from "./heavy-plugin.ts";\n` +
        `export default { plugins: [heavy()], desktop: { app: { identifier: "com.example.g" } } };\n`,
    );
    const entry = scaffoldFiles({ dir, desktop: true }).find((f) => f.path === "desktop.ts")!;
    await Deno.writeTextFile(join(dir, "desktop.ts"), entry.content);
    await syncDesktopAppConfigAt(dir, { desktop: { app: { identifier: "com.example.g" } } });
    // A file URL, not a path: `deno info` reads `C:\…` as a URL whose scheme is `c:`.
    const root = toFileUrl(join(dir, "desktop.ts")).href;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", "--config", join(dir, "deno.json"), root],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    const graph = JSON.parse(new TextDecoder().decode(out.stdout)) as {
      modules: Array<{ specifier: string; error?: string }>;
    };
    const failed = graph.modules.filter((m) => m.error);
    assertEquals(failed, [], "every module of the entry's graph loads");
    const specs = graph.modules.map((m) => m.specifier);
    assert(specs.some((s) => s.endsWith("/.deno-desktop/config.json")), specs.join("\n"));
    assert(!specs.some((s) => s.endsWith("/denext.config.ts")), "the config module is compiled in");
    assert(!specs.some((s) => s.endsWith("/heavy-plugin.ts")), "a plugin is compiled in");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the examples' desktop entries import .deno-desktop/config.json, committed in sync with the config", async () => {
  const { desktopRuntimeConfigText } = await import("../src/build/desktop-app-config.ts");
  for (const example of ["native", "clerk", "desktop-kitchen-sink", "rn-desktop"]) {
    const dir = join(REPO, "examples", example);
    const entry = await Deno.readTextFile(join(dir, "desktop.ts"));
    assertStringIncludes(
      entry,
      'import config from "./.deno-desktop/config.json" with { type: "json" };',
      `${example}/desktop.ts`,
    );
    assert(!entry.includes('"./denext.config.ts"'), `${example}/desktop.ts imports the config`);
    // The file the export's sync rewrites from the config: committed as it would write it, so the
    // entry type-checks on a fresh clone and `denext desktop run` leaves the folder unchanged.
    const config = (await import(toFileUrl(join(dir, "denext.config.ts")).href)).default;
    assertEquals(
      await Deno.readTextFile(join(dir, DESKTOP_RUNTIME_CONFIG_FILE)),
      desktopRuntimeConfigText(config),
      `examples/${example}/${DESKTOP_RUNTIME_CONFIG_FILE} is stale`,
    );
  }
});
