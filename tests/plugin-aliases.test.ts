// The examples/plugin-aliases plugin, exercised end-to-end. It's the first real
// consumer of the ROUTE-SYNTHESIZER seam (pages-router uses the request-handler +
// build-step seams), so this doubles as coverage that a third-party plugin can add
// routes that render through the ordinary core pipeline.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createApp, defaultLoader, scanRoutes } from "../src/server/mod.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import { aliasesPlugin } from "../examples/plugin-aliases/plugin.ts";

const APP = new URL("../examples/plugin-aliases/app", import.meta.url).pathname;

async function manifestWithPlugin() {
  await applyPlugins({
    projectRoot: join(APP, ".."),
    appDir: APP,
    config: { plugins: [aliasesPlugin({ "/home": "/", "/about-us": "/about" })] },
    mode: "prod",
    load: defaultLoader,
  });
  // scanRoutes runs registered synthesizers, so the aliases appear here.
  return await scanRoutes(APP);
}

Deno.test("aliases plugin injects alias routes pointing at the target's module", async () => {
  resetPlugins();
  try {
    const manifest = await manifestWithPlugin();

    const home = manifest.pages.find((p) => p.routePath === "/");
    const alias = manifest.pages.find((p) => p.routePath === "/home");
    assert(home && alias, "both / and its /home alias exist");
    assertEquals(alias!.filePath, home!.filePath, "alias reuses the target page module");

    const about = manifest.pages.find((p) => p.routePath === "/about");
    const aboutAlias = manifest.pages.find((p) => p.routePath === "/about-us");
    assert(about && aboutAlias, "both /about and its /about-us alias exist");
    assertEquals(aboutAlias!.filePath, about!.filePath);
  } finally {
    resetPlugins();
  }
});

Deno.test("an aliased route renders the same HTML as its target", async () => {
  resetPlugins();
  try {
    const manifest = await manifestWithPlugin();
    const app = createApp({ getManifest: () => manifest, load: defaultLoader });

    const canonical = await app(new Request("http://localhost/about"));
    const aliased = await app(new Request("http://localhost/about-us"));
    assertEquals(canonical.status, 200);
    assertEquals(aliased.status, 200);
    const [a, b] = [await canonical.text(), await aliased.text()];
    assertStringIncludes(a, "<h1>About</h1>");
    assertStringIncludes(b, "<h1>About</h1>");
  } finally {
    resetPlugins();
  }
});

Deno.test("resetPlugins() clears a plugin's route synthesizer (no leak)", async () => {
  resetPlugins();
  // Register the plugin, then reset — a fresh scan must NOT carry the aliases.
  await manifestWithPlugin();
  resetPlugins();

  const clean = await scanRoutes(APP);
  assert(
    !clean.pages.some((p) => p.routePath === "/home" || p.routePath === "/about-us"),
    "after resetPlugins() the synthesizer must not run — its aliases are gone",
  );
});
