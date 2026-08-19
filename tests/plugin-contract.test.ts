import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";
import {
  applyPlugins,
  type DenextPlugin,
  getPluginRequestHandler,
  type PluginBuildContext,
  resetPlugins,
  runPluginBuildSteps,
  runPluginTeardown,
} from "../src/plugin/mod.ts";
import { join } from "@std/path";

const EMPTY_MANIFEST: RouteManifest = {
  pages: [],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
};

// --- app.ts claim-hook (matchExternal) behavior -----------------------------

Deno.test("matchExternal claims an otherwise-unmatched request", async () => {
  const app = createApp({
    getManifest: () => EMPTY_MANIFEST,
    load: () => Promise.reject(new Error("no modules")),
    matchExternal: (request) =>
      new URL(request.url).pathname === "/pages-route"
        ? new Response("claimed by plugin", { status: 200 })
        : null,
  });

  const claimed = await app(new Request("http://localhost/pages-route"));
  assertEquals(claimed.status, 200);
  assertEquals(await claimed.text(), "claimed by plugin");

  // A path the hook returns null for falls through to the normal 404.
  const missed = await app(new Request("http://localhost/nope"));
  assertEquals(missed.status, 404);
});

Deno.test("App Router routes win over matchExternal (core precedence)", async () => {
  const manifest: RouteManifest = {
    ...EMPTY_MANIFEST,
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "home.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
  };
  let hookCalled = false;
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: (_p: PageProps) => h("h1", null, "app router") }),
    matchExternal: () => {
      hookCalled = true;
      return new Response("plugin", { status: 200 });
    },
  });

  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "app router");
  assert(!hookCalled, "matchExternal must not run when the App Router already matched");
});

Deno.test("no matchExternal → normal 404 (zero-cost when absent)", async () => {
  const app = createApp({
    getManifest: () => EMPTY_MANIFEST,
    load: () => Promise.reject(new Error("no modules")),
  });
  const res = await app(new Request("http://localhost/whatever"));
  assertEquals(res.status, 404);
});

// --- plugin registry helpers ------------------------------------------------

Deno.test("applyPlugins runs setup once and wires the three seams", async () => {
  resetPlugins();
  let setups = 0;
  const buildContexts: PluginBuildContext[] = [];
  const plugin: DenextPlugin = {
    name: "test-plugin",
    setup(ctx) {
      setups++;
      assertEquals(ctx.mode, "prod");
      ctx.addRequestHandler((request) =>
        new URL(request.url).pathname === "/from-plugin"
          ? new Response("handled", { status: 201 })
          : null
      );
      ctx.addBuildStep((bctx) => {
        buildContexts.push(bctx);
      });
    },
  };
  const base = {
    projectRoot: "/proj",
    appDir: "/proj/app",
    config: { plugins: [plugin] },
    mode: "prod" as const,
    load: () => Promise.resolve({}),
  };

  await applyPlugins(base);
  await applyPlugins(base); // idempotent by name
  assertEquals(setups, 1);

  // Request handler is exposed and claims its path.
  const handler = getPluginRequestHandler();
  assert(handler, "expected a combined request handler");
  const hit = await handler!(new Request("http://localhost/from-plugin"));
  assertEquals(hit?.status, 201);
  const miss = await handler!(new Request("http://localhost/other"));
  assertEquals(miss, null);

  // Build step fires with the passed context.
  await runPluginBuildSteps({
    projectRoot: "/proj",
    appDir: "/proj/app",
    outDir: "/proj/.denext",
    config: { plugins: [plugin] },
  });
  assertEquals(buildContexts.length, 1);
  assertEquals(buildContexts[0].outDir, "/proj/.denext");

  resetPlugins();
  assertEquals(getPluginRequestHandler(), undefined);
});

Deno.test("no plugins → getPluginRequestHandler is undefined", async () => {
  resetPlugins();
  await applyPlugins({
    projectRoot: "/p",
    appDir: "/p/app",
    config: {},
    mode: "build",
    load: () => Promise.resolve({}),
  });
  assertEquals(getPluginRequestHandler(), undefined);
});

Deno.test("addTeardown disposers run LIFO on drain, then are cleared", async () => {
  resetPlugins();
  const order: string[] = [];
  const plugin: DenextPlugin = {
    name: "teardown-plugin",
    setup(ctx) {
      ctx.addTeardown(() => {
        order.push("first-registered");
      });
      ctx.addTeardown(async () => {
        await Promise.resolve();
        order.push("second-registered");
      });
    },
  };
  await applyPlugins({
    projectRoot: "/p",
    appDir: "/p/app",
    config: { plugins: [plugin] },
    mode: "prod",
    load: () => Promise.resolve({}),
  });

  await runPluginTeardown();
  // Most-recently-registered first (reverse), so dependencies unwind cleanly.
  assertEquals(order, ["second-registered", "first-registered"]);

  // A second run is a no-op — teardowns were cleared.
  await runPluginTeardown();
  assertEquals(order.length, 2);
  resetPlugins();
});

Deno.test("a throwing teardown doesn't strand the others", async () => {
  resetPlugins();
  let ran = false;
  const plugin: DenextPlugin = {
    name: "throwing-teardown",
    setup(ctx) {
      ctx.addTeardown(() => {
        ran = true;
      });
      ctx.addTeardown(() => {
        throw new Error("boom");
      });
    },
  };
  await applyPlugins({
    projectRoot: "/p",
    appDir: "/p/app",
    config: { plugins: [plugin] },
    mode: "prod",
    load: () => Promise.resolve({}),
  });
  await runPluginTeardown(); // must not throw
  assert(ran, "the earlier-registered teardown still ran after a later one threw");
  resetPlugins();
});

Deno.test("a plugin can contribute routes via an async route synthesizer", async () => {
  resetPlugins();
  const dir = await Deno.makeTempDir({ prefix: "denext_plugin_synth_" });
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  try {
    // A plugin whose synthesizer injects a route only when the fixture opts in via
    // a marker route — so the module-global registration can't affect other tests.
    const plugin: DenextPlugin = {
      name: "synth-plugin",
      setup(ctx) {
        ctx.addRouteSynthesizer((manifest) => {
          const marker = manifest.pages.find((p) => p.routePath === "/__plugin_marker");
          if (!marker) return;
          manifest.pages.push({
            ...marker,
            routePath: "/__plugin_marker/injected",
            pattern: parsePattern("__plugin_marker/injected"),
          });
        });
      },
    };
    await applyPlugins({
      projectRoot: dir,
      appDir: join(dir, "app"),
      config: { plugins: [plugin] },
      mode: "build",
      load: () => Promise.resolve({}),
    });

    await Deno.mkdir(join(dir, "app", "__plugin_marker"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app", "__plugin_marker", "page.tsx"),
      "export default function () {}\n",
    );
    const manifest = await scanRoutes(join(dir, "app"));
    assert(
      manifest.pages.some((p) => p.routePath === "/__plugin_marker/injected"),
      "expected the plugin's synthesizer to inject a derived route",
    );
  } finally {
    resetPlugins();
    await Deno.remove(dir, { recursive: true });
  }
});
