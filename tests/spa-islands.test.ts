// SPA mode's `client:*` directives: deferred mount + code split. The build-time rewrite
// (src/build/spa-islands.ts) turns each directive component element into `denext/spa-island`'s
// `SpaIsland` with a loader, dropping the static import when the directive elements are the
// component's only use; the runtime (src/client/spa-island.ts) renders the placeholder until the
// trigger (each of load / only / idle / visible / media / interaction, driven through the Flight
// islands' scheduler), then imports and mounts the component. The SPA build is checked on both
// bundler paths: the component's module lands in its own chunk, outside the entry's static graph.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { act, render } from "../src/testing/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode, VNodeChild } from "../src/jsx/types.ts";
import { ErrorBoundary } from "../src/runtime/error-boundary.ts";
import { DomEl, fireEventOn } from "../src/testing/dom.ts";
import { all } from "./helpers/virtual-list.ts";
import { SpaIsland } from "../src/client/spa-island.ts";
import {
  getIslandTimeline,
  type LazyScheduler,
  resetLazyIslands,
  setLazyScheduler,
} from "../src/client/lazy-hydrate.ts";
import { spaIslandSources, transformSpaIslands } from "../src/build/spa-islands.ts";
import { bundleSpaInto } from "../src/build/spa/bundle.ts";
import { resolveProject } from "../src/build/paths.ts";
import { createUnbundledDev } from "../src/build/dev-unbundled.ts";

// ── the rewrite ─────────────────────────────────────────────────────────────────────────────

Deno.test("spa islands rewrite: a directive element becomes SpaIsland with a loader; its only import is dropped", async () => {
  const src = `"use client";
import Chart from "./chart.tsx";
import { Diff as D } from "./diff.tsx";
import { Plain } from "./plain.tsx";
export function App({ d }) {
  return <main>
    <Chart client:visible data={d} />
    <D client:media="(min-width: 800px)" left="a">kids</D>
    <Plain />
  </main>;
}
`;
  const r = await transformSpaIslands(src);
  assert(r.changed);
  assertEquals(r.islands, 2);
  assertEquals(r.split, ["./chart.tsx", "./diff.tsx"]);
  assert(r.code.startsWith('"use client";\n'), "the directive prologue stays first");
  assertStringIncludes(r.code, 'import { SpaIsland as __DnxSpaIsland } from "denext/spa-island";');
  assertStringIncludes(
    r.code,
    'const __dnxLoad0 = () => import("./chart.tsx").then((m) => m["default"]);',
  );
  assertStringIncludes(
    r.code,
    'const __dnxLoad1 = () => import("./diff.tsx").then((m) => m["Diff"]);',
  );
  assertStringIncludes(r.code, "<__DnxSpaIsland __dnxLoad={__dnxLoad0} client:visible data={d} />");
  assertStringIncludes(
    r.code,
    '<__DnxSpaIsland __dnxLoad={__dnxLoad1} client:media="(min-width: 800px)" left="a">kids</__DnxSpaIsland>',
  );
  assert(!r.code.includes('import Chart from "./chart.tsx"'), "chart's static import dropped");
  assert(!r.code.includes("import { Diff as D }"), "diff's static import dropped");
  assertStringIncludes(r.code, 'import { Plain } from "./plain.tsx";', "an eager import stays");
});

Deno.test("spa islands rewrite: a component also used eagerly keeps its import (deferred mount, no split)", async () => {
  const src = `import Chart from "./chart.tsx";
export const A = () => <><Chart client:idle /><Chart /></>;
export const ref = Chart;
`;
  const r = await transformSpaIslands(src);
  assertEquals(r.islands, 1);
  assertEquals(r.split, []);
  assertStringIncludes(r.code, 'import Chart from "./chart.tsx";');
  assertStringIncludes(r.code, "<__DnxSpaIsland __dnxLoad={__dnxLoad0} client:idle />");
  assertStringIncludes(r.code, "<Chart />");
});

Deno.test("spa islands rewrite: every strategy is recognized; unknown names, members, shadows and plain modules are left alone", async () => {
  for (const s of ["load", "idle", "visible", "interaction", "media", "only"]) {
    const r = await transformSpaIslands(
      `import X from "./x.tsx";\nexport const A = () => <X client:${s} />;\n`,
    );
    assertEquals(r.islands, 1, s);
  }
  const untouched = [
    `import X from "./x.tsx";\nexport const A = () => <X client:sometime />;\n`,
    `import * as UI from "./ui.tsx";\nexport const A = () => <UI.Chart client:visible />;\n`,
    `import X from "./x.tsx";\nexport const A = (X) => <X client:visible />;\n`,
    `export const A = () => <div client:visible />;\n`,
    `import X from "./x.tsx";\nexport const A = () => <X />;\n`,
    `import type X from "./x.tsx";\nexport const A = () => <X client:visible />;\n`,
  ];
  for (const src of untouched) {
    const r = await transformSpaIslands(src);
    assertEquals(r.changed, false, src);
    assertEquals(r.code, src);
  }
});

Deno.test("spa islands rewrite: a relocated module (deno bundle path) gets absolute specifiers", async () => {
  const src = `import Chart from "./chart.tsx";\nimport { useState } from "denext";\n` +
    `import { util } from "../lib/util.ts";\nexport const A = () => <Chart client:visible n={util} />;\n`;
  const r = await transformSpaIslands(src, { moduleUrl: "file:///app/src/app.tsx" });
  assertStringIncludes(r.code, 'import("file:///app/src/chart.tsx")');
  assertStringIncludes(r.code, '"file:///app/lib/util.ts"');
  assertStringIncludes(r.code, 'from "denext"', "a bare specifier stays");
  assert(!r.code.includes('"./chart.tsx"'), "the dropped import left no relative specifier");
});

Deno.test("spa islands: the sources scan finds only modules with a directive", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_islands_scan_" });
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src/a.tsx"),
      "export const A = () => <X client:visible />;",
    );
    await Deno.writeTextFile(join(dir, "src/b.tsx"), "export const B = () => <X />;");
    await Deno.writeTextFile(join(dir, "node_modules/pkg/c.tsx"), "<X client:idle />");
    assertEquals(await spaIslandSources(dir), [join(dir, "src/a.tsx")]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the runtime ─────────────────────────────────────────────────────────────────────────────

/** A scheduler whose idle / visible / media triggers fire when the test says. */
function manualScheduler(): LazyScheduler & { fire(kind: "idle" | "visible" | "media"): void } {
  const pending: Record<string, (() => void)[]> = { idle: [], visible: [], media: [] };
  return {
    idle: (cb) => void pending.idle.push(cb),
    visible: (_el, cb) => {
      pending.visible.push(cb);
      return () => void pending.visible.splice(pending.visible.indexOf(cb) >>> 0, 1);
    },
    media: (_q, cb) => {
      pending.media.push(cb);
      return () => {};
    },
    fire(kind) {
      for (const cb of pending[kind].splice(0)) cb();
    },
  };
}

/** The deferred component: renders its props, and counts how often its module was imported. */
let imported = 0;
function Chart(props: { label: string; children?: VNodeChild }): VNode {
  return h("p", { "data-chart": props.label }, props.children);
}
/** A fresh loader per test (imports are cached per loader, as the build's module constants). */
const chartLoader = () => () => {
  imported++;
  return Promise.resolve(Chart);
};
let loadChart = chartLoader();

const texts = (screen: { container: unknown }) =>
  all(screen as never).filter((e) => e.getAttribute("data-chart") !== null).map((e) =>
    e.getAttribute("data-chart")
  );
const placeholders = (screen: { container: unknown }) =>
  all(screen as never).filter((e) => e.getAttribute("data-dnx-island") !== null);

/** Let the import settle and the mount commit. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

async function withScheduler(fn: (s: ReturnType<typeof manualScheduler>) => Promise<void>) {
  const s = manualScheduler();
  setLazyScheduler(s);
  imported = 0;
  loadChart = chartLoader();
  try {
    await fn(s);
  } finally {
    resetLazyIslands();
    setLazyScheduler();
  }
}

for (const strategy of ["idle", "visible", "media"] as const) {
  Deno.test(`SpaIsland client:${strategy}: the placeholder until the trigger, then the component with its props`, async () => {
    await withScheduler(async (s) => {
      const directive = strategy === "media" ? { "client:media": "(min-width: 800px)" } : {
        [`client:${strategy}`]: true,
      };
      const screen = await render(
        h(SpaIsland as never, { __dnxLoad: loadChart, ...directive, label: "sales" }, "kids"),
      );
      await settle();
      assertEquals(texts(screen), [], "not mounted before the trigger");
      assertEquals(imported, 0, "and its module not imported");
      const [ph] = placeholders(screen);
      assertEquals(ph.getAttribute("data-dnx-strategy"), strategy);
      await act(() => s.fire(strategy));
      await settle();
      assertEquals(texts(screen), ["sales"]);
      assertEquals(imported, 1);
      assertEquals(placeholders(screen), [], "the placeholder is gone");
      const p = all(screen as never).find((e) => e.getAttribute("data-chart") === "sales")!;
      assertEquals(p.textContent, "kids", "children pass through");
      assertEquals(p.getAttribute("client:" + strategy), null, "no directive reaches the DOM");
      await screen.unmount();
    });
  });
}

for (const strategy of ["load", "only"] as const) {
  Deno.test(`SpaIsland client:${strategy}: mounts right away (its chunk still loads on its own)`, async () => {
    await withScheduler(async () => {
      const screen = await render(
        h(SpaIsland as never, { __dnxLoad: loadChart, [`client:${strategy}`]: true, label: "a" }),
      );
      await settle();
      assertEquals(texts(screen), ["a"]);
      await screen.unmount();
    });
  });
}

Deno.test("SpaIsland client:interaction: the placeholder until the first interaction inside it", async () => {
  await withScheduler(async () => {
    const screen = await render(h(SpaIsland as never, {
      __dnxLoad: loadChart,
      "client:interaction": true,
      "client:placeholder": h("button", { "data-ph": "" }, "Open the diff"),
      label: "diff",
    }));
    await settle();
    const button = all(screen as never).find((e) => e.getAttribute("data-ph") !== null)!;
    assertEquals(button.textContent, "Open the diff", "the placeholder renders");
    assertEquals(placeholders(screen)[0].getAttribute("style"), "display:contents");
    assertEquals(imported, 0);
    await act(() => fireEventOn(button, "pointerdown"));
    await settle();
    assertEquals(texts(screen), ["diff"]);
    assertEquals(imported, 1);
    await screen.unmount();
  });
});

Deno.test("SpaIsland client:interaction: the trigger listeners are passive (touchstart never holds a scroll)", async () => {
  const calls: Array<[string, unknown]> = [];
  const proto = DomEl.prototype as unknown as { addEventListener: (...a: unknown[]) => void };
  const original = proto.addEventListener;
  proto.addEventListener = function (this: unknown, type: unknown, fn: unknown, options: unknown) {
    calls.push([type as string, options]);
    return original.call(this, type, fn, options);
  };
  try {
    await withScheduler(async () => {
      const screen = await render(h(SpaIsland as never, {
        __dnxLoad: loadChart,
        "client:interaction": true,
        label: "diff",
      }));
      await settle();
      const touch = calls.find(([type]) => type === "touchstart");
      assertEquals(touch?.[1], { passive: true });
      await screen.unmount();
    });
  } finally {
    proto.addEventListener = original;
  }
});

Deno.test("SpaIsland: one import per loader; a list's islands share it; the dev timeline records each mount", async () => {
  await withScheduler(async (s) => {
    const g = globalThis as { __denextDev?: boolean; __denextIslands?: unknown[] };
    g.__denextDev = true;
    g.__denextIslands = [];
    try {
      const screen = await render(h(
        "div",
        null,
        ["a", "b", "c"].map((label) =>
          h(SpaIsland as never, { key: label, __dnxLoad: loadChart, "client:visible": true, label })
        ),
      ));
      await settle();
      await act(() => s.fire("visible"));
      await settle();
      assertEquals(texts(screen), ["a", "b", "c"]);
      assertEquals(imported, 1, "the loader ran once");
      assertEquals(getIslandTimeline().map((r) => r.strategy), ["visible", "visible", "visible"]);
      await screen.unmount();
    } finally {
      delete g.__denextDev;
      delete g.__denextIslands;
    }
  });
});

Deno.test("SpaIsland: a failed import reaches the nearest error boundary; an unmounted island never mounts", async () => {
  await withScheduler(async (s) => {
    const Fallback = (p: { error: unknown }): VNode =>
      h("p", { "data-error": String((p.error as Error).message ?? p.error) });
    const failing = () => Promise.reject(new Error("chunk 404"));
    const screen = await render(
      h(
        ErrorBoundary as never,
        { fallback: Fallback },
        h(SpaIsland as never, { __dnxLoad: failing, "client:load": true }),
      ),
    );
    await settle();
    const err = all(screen as never).find((e) => e.getAttribute("data-error") !== null);
    assertEquals(err?.getAttribute("data-error"), "chunk 404", "the boundary's fallback renders");
    await screen.unmount();

    const gone = await render(
      h(SpaIsland as never, { __dnxLoad: loadChart, "client:visible": true, label: "x" }),
    );
    await gone.unmount();
    await act(() => s.fire("visible"));
    await settle();
    assertEquals(imported, 0, "an island unmounted before its trigger never imports");
  });
});

// ── the build: the component's module is its own chunk ─────────────────────────────────────

const ROOT = new URL("../", import.meta.url);

/** The files an entry's static imports reach (relative `/_denext/client/` chunk URLs). */
async function staticGraph(
  dir: string,
  file: string,
  seen = new Set<string>(),
): Promise<Set<string>> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = await Deno.readTextFile(join(dir, file));
  const specs = [
    ...text.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w${},*\s]+from\s*)?["']([^"']+)["']/g),
  ].map((m) => m[1]);
  for (const spec of specs) {
    const name = spec.split("/").at(-1)!;
    try {
      await Deno.stat(join(dir, name));
      await staticGraph(dir, name, seen);
    } catch { /* not a chunk of this build */ }
  }
  return seen;
}

/** Build a SPA whose app defers a component; return where its marker landed. */
async function buildSplit(
  compat: boolean,
  dev = false,
): Promise<{ graph: Set<string>; marker: string[]; app: string[] }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_spa_islands_build_" }));
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "src/main.tsx"),
      `import { createRoot } from "denext/client";\nimport { App } from "./app.tsx";\n` +
        `const el = document.getElementById("root");\nif (el) createRoot(el).render(<App />);\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src/app.tsx"),
      `import Chart from "./chart.tsx";\nexport function App() {\n` +
        `  return <main><h1>APP_MODULE</h1><Chart client:visible label="sales" /></main>;\n}\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src/chart.tsx"),
      `export default function Chart(p: { label: string }) {\n` +
        `  return <p data-chart="DEFERRED_CHART_MODULE">{p.label}</p>;\n}\n`,
    );
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      `export default { mode: "spa", compatibilityMode: ${compat}, spa: { entry: "./src/main.tsx" } };\n`,
    );
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": new URL("mod.ts", ROOT).href,
          "denext/jsx-runtime": new URL("src/jsx/jsx-runtime.ts", ROOT).href,
          "denext/client": new URL("src/client/mod.ts", ROOT).href,
          "denext/class-runtime": new URL("src/class-runtime.ts", ROOT).href,
        },
      }),
    );
    const paths = await resolveProject(dir);
    const out = join(dir, "out");
    await Deno.mkdir(out);
    await bundleSpaInto(paths, join(dir, "src", "main.tsx"), out, false, dev);
    const marker: string[] = [];
    const app: string[] = [];
    for await (const e of Deno.readDir(out)) {
      if (!e.name.endsWith(".js")) continue;
      const text = await Deno.readTextFile(join(out, e.name));
      if (text.includes("DEFERRED_CHART_MODULE")) marker.push(e.name);
      if (text.includes("APP_MODULE")) app.push(e.name);
    }
    return { graph: await staticGraph(out, "index.js"), marker, app };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

for (const dev of [false, true]) {
  for (const compat of [false, true]) {
    const path = compat ? "compat esbuild" : "native deno bundle";
    Deno.test(`spa islands ${dev ? "bundled dev build" : "build"} (${path} path): the deferred component is its own chunk`, async () => {
      const { graph, marker, app } = await buildSplit(compat, dev);
      assertEquals(marker.length, 1, `the component's code is in one file (${marker})`);
      assert(marker[0] !== "index.js", "not in the entry");
      // A dev build loads the app itself through a chunk, so the entry's graph alone would not
      // tell a split: the component is also outside the app module's chunk.
      assert(!app.includes(marker[0]), `not in the app module's chunk (${app})`);
      assert(!graph.has(marker[0]), `not in the entry's static graph (${[...graph]})`);
    });
  }
}

// ── the unbundled dev loop: the same rewrite, per module ────────────────────────────────────

/** A SPA project whose `src/app.tsx` defers `./chart.tsx`, and an unbundled dev loop over it. */
async function unbundledApp(
  opts: { spaIslands?: boolean; features?: Record<string, boolean> },
  app = `import Chart from "./chart.tsx";\nexport function App() {\n` +
    `  return <main><Chart client:visible label="sales" /></main>;\n}\n`,
) {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_spa_islands_dev_" }));
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(join(dir, "src/app.tsx"), app);
  await Deno.writeTextFile(
    join(dir, "src/chart.tsx"),
    `export default function Chart(p: { label: string }) { return <p>{p.label}</p>; }\n`,
  );
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": new URL("mod.ts", ROOT).href,
        "denext/jsx-runtime": new URL("src/jsx/jsx-runtime.ts", ROOT).href,
        "denext/jsx-dev-runtime": new URL("src/jsx/jsx-runtime.ts", ROOT).href,
        "denext/client": new URL("src/client/mod.ts", ROOT).href,
      },
    }),
  );
  const dev = createUnbundledDev({
    projectDir: dir,
    appDir: join(dir, "src"),
    configPath: join(dir, "deno.json"),
    outDir: join(dir, ".denext"),
    compat: false,
    ...opts,
  });
  return {
    code: async () => (await dev._internal.transform(join(dir, "src/app.tsx"), "web")).code,
    async [Symbol.asyncDispose]() {
      await dev.stop();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("spa islands unbundled dev: a served module's directive elements are deferred mounts", async () => {
  await using app = await unbundledApp({ spaIslands: true });
  const code = await app.code();
  assertStringIncludes(code, "__DnxSpaIsland", "the element is a SpaIsland");
  assertStringIncludes(code, "spa-island", "denext/spa-island is imported");
  assert(/import\(\s*["'][^"']*chart\.tsx/.test(code), `chart.tsx is a dynamic import:\n${code}`);
  assert(!/^\s*import\s[^(]*chart\.tsx/m.test(code), "and no longer a static one");
});

Deno.test("spa islands unbundled dev: without spaIslands (the App Router loop) the module is served as written", async () => {
  await using app = await unbundledApp({});
  const code = await app.code();
  assert(!code.includes("__DnxSpaIsland"), code);
  assert(/^\s*import\s[^(]*chart\.tsx/m.test(code), "chart.tsx stays a static import");
});

Deno.test("unbundled dev: a build transform that throws warns once and serves the module as written", async () => {
  // A `features` value whose read throws: the fold's own failure path (a module that does not
  // parse is left alone, so a throw is an internal failure the developer must hear about).
  const features = Object.defineProperty({}, "FLAG", {
    enumerable: true,
    get(): boolean {
      throw new Error("FLAG unreadable");
    },
  }) as Record<string, boolean>;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await using app = await unbundledApp(
      { features },
      `import { feature } from "denext/feature";\nexport const on = feature("FLAG");\n`,
    );
    assertStringIncludes(await app.code(), "feature(", "served unfolded");
  } finally {
    console.warn = warn;
  }
  const mine = warnings.filter((w) => w.includes("feature() fold"));
  assertEquals(mine.length, 1, warnings.join("\n"));
  assertStringIncludes(mine[0], "FLAG unreadable");
  assertStringIncludes(mine[0], "app.tsx");
});
