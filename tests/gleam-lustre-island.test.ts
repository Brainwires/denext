// Lustre apps as denext islands (`lustreIsland`, the Lustre kit, `.denext/lustre.ts`). The kit
// is driven with fake Lustre functions that record what denext asked of them; the island renders
// through the server renderer and mounts through `denext/testing`'s DOM. The real Lustre runtime
// is exercised by the example's browser e2e (tests/e2e/lustre.e2e.test.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { render } from "../src/testing/mod.ts";
import { useState } from "../src/runtime/hooks.ts";
import { gleam, lustreIsland, lustreKit } from "../src/gleam.ts";
import type { LustreApp, LustreModules } from "../src/lustre/kit.ts";
import { shadowFromPrerender } from "../src/lustre/kit.ts";
import { lustreVersion, writeLustreKits } from "../src/build/lustre-kit.ts";
import type { PluginContext, PluginPrepareStep } from "../src/plugin/mod.ts";
import { removeTempDirSync } from "./helpers/temp.ts";

/** A Gleam `Ok` / `Error` as Gleam's JavaScript output builds them. */
const ok = <T>(value: T) => Object.assign([value], { isOk: () => true });
const err = <T>(value: T) => Object.assign([value], { isOk: () => false });

interface Started {
  root: Element;
  flags: unknown;
  stopped: boolean;
  /** Events dispatched on the root after Lustre started. */
  events: string[];
  /** The root's HTML when Lustre started on it (what it adopted). */
  adopted: string;
}

/** Fake Lustre functions: `view` renders `<p>{model}</p>`, `start` records the mount. */
function fakeLustre(options: { refuse?: boolean } = {}) {
  const started: Started[] = [];
  const registered: string[] = [];
  const modules: LustreModules = {
    version: "5.7.1",
    start(_app, root, flags) {
      if (options.refuse) return err("NotABrowser");
      const s: Started = {
        root,
        flags,
        stopped: false,
        events: [],
        adopted: (root as Element).innerHTML,
      };
      // The test DOM has no dispatchEvent: record what the island dispatches on its root.
      (root as unknown as { dispatchEvent(e: Event): boolean }).dispatchEvent = (e) => {
        s.events.push(e.type);
        return true;
      };
      started.push(s);
      return ok(s);
    },
    register(_app, name) {
      if (registered.includes(name)) return err("ComponentAlreadyRegistered");
      registered.push(name);
      return ok(undefined);
    },
    send(runtime, message) {
      if (message === "shutdown") (runtime as Started).stopped = true;
      return undefined;
    },
    shutdown: () => "shutdown",
    is_browser: () => false,
    to_string: (element) => String(element),
    prerender: (_app, tag, attributes, children) =>
      `<${tag}${(attributes as string[]).join("")}>` +
      `<template shadowrootmode="closed"><p>${
        (children as unknown[]).length
      }</p></template></${tag}>`,
    attribute: (name, value) => ` ${name}="${value}"`,
    toList: (items) => items,
  };
  return { modules, started, registered };
}

/** A Lustre app whose model is its flags and whose view is `<p>{model}</p>`. */
const app: LustreApp<number> = {
  init: (flags: number) => [flags, null],
  update: (model) => [model, null],
  view: (model) => `<p>${model}</p>`,
  config: {},
};

Deno.test("lustreKit: render, start / refuse, stop, register once, prerender's shadow root", () => {
  const fake = fakeLustre();
  const kit = lustreKit(fake.modules);
  assertEquals(kit.version, "5.7.1");
  assertEquals(kit.render(app, 41), "<p>41</p>");
  const root = { innerHTML: "<p>41</p>" } as unknown as Element;
  const runtime = kit.start(app, root, 41);
  assert(runtime);
  assertEquals(fake.started[0].flags, 41);
  kit.stop(runtime);
  assert(fake.started[0].stopped, "stop sends lustre.shutdown()");

  assert(kit.register(app as never, "my-counter"));
  assert(kit.register(app as never, "my-counter"), "a second registration is a no-op");
  assertEquals(fake.registered, ["my-counter"]);

  assertEquals(kit.prerender(app as never, "my-counter", { start: "3" }), {
    mode: "closed",
    delegatesFocus: false,
    html: "<p>0</p>",
  });

  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...a: unknown[]) => warnings.push(a);
  try {
    assertEquals(lustreKit(fakeLustre({ refuse: true }).modules).start(app, root, 1), null);
    assertEquals(warnings.length, 1, "a refused start is logged");
  } finally {
    console.warn = warn;
  }
});

Deno.test("shadowFromPrerender: the template's mode and contents, or null for another shape", () => {
  const html = '<x-y a="1"><template shadowrootmode="open" shadowrootdelegatesfocus>' +
    "<b>hi</b></template></x-y>";
  assertEquals(shadowFromPrerender(html, "x-y"), {
    mode: "open",
    delegatesFocus: true,
    html: "<b>hi</b>",
  });
  assertEquals(shadowFromPrerender("<x-y><b>no template</b></x-y>", "x-y"), null);
  assertEquals(shadowFromPrerender(html, "other-tag"), null);
});

Deno.test("lustreIsland: the server renders the app's first view inside the island root", async () => {
  const kit = lustreKit(fakeLustre().modules);
  const Counter = lustreIsland(kit, app, {
    flags: (props: { start: number }) => props.start,
    attributes: () => ({ class: "counter" }),
  });
  const html = await renderToString(h(Counter, { start: 7 }));
  assertEquals(html, '<div class="counter" data-denext-lustre=""><p>7</p></div>');
  // Default: the `flags` prop.
  const Plain = lustreIsland(kit, app, { tag: "section" });
  assertEquals(
    await renderToString(h(Plain, { flags: 2 })),
    '<section data-denext-lustre=""><p>2</p></section>',
  );
});

Deno.test("lustreIsland: starts Lustre on the root it rendered, restarts on new flags, stops and clears on unmount", async () => {
  const fake = fakeLustre();
  const kit = lustreKit(fake.modules);
  const Counter = lustreIsland(kit, app, { flags: (p: { start: number }) => p.start });
  let setStart: (n: number) => void = () => {};
  let setShown: (b: boolean) => void = () => {};
  let setTick: (n: number) => void = () => {};
  function Host() {
    const [start, s1] = useState(5);
    const [shown, s2] = useState(true);
    const [tick, s3] = useState(0);
    setStart = s1;
    setShown = s2;
    setTick = s3;
    return h("main", { "data-tick": String(tick) }, shown ? h(Counter, { start }) : null);
  }
  const screen = await render(h(Host, null));
  assertEquals(fake.started.length, 1);
  const first = fake.started[0];
  assertEquals(first.flags, 5);
  assertEquals(first.adopted, "<p>5</p>", "Lustre starts on the root holding the first paint");
  assertEquals(first.events, ["lustre:mount"], "the root announces that Lustre runs it");
  assertEquals(first.root.getAttribute("data-denext-lustre"), "");

  // A parent re-render with the same props leaves the running app alone.
  await screen.act(() => setTick(1));
  assertEquals(fake.started.length, 1);
  assert(!first.stopped);

  // New flags: the old runtime is stopped, the root cleared, the app started again on it.
  await screen.act(() => setStart(9));
  assertEquals(fake.started.length, 2);
  assert(first.stopped);
  assertEquals(fake.started[1].flags, 9);
  assertEquals(fake.started[1].root, first.root, "the same root element");
  assertEquals(fake.started[1].adopted, "", "cleared before the restart");

  // Unmount: stopped (a no-op upstream for SPAs) and the root emptied by denext itself.
  first.root.innerHTML = "<p>what Lustre rendered</p>";
  await screen.act(() => setShown(false));
  assert(fake.started[1].stopped);
  assertEquals(first.root.innerHTML, "", "unmount clears the root");
  await screen.unmount();
});

Deno.test("writeLustreKits: .denext/lustre.ts for a Lustre project, rewritten only on change, removed without Lustre", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-kit-" }));
  try {
    const gleamDir = join(app, "gleam");
    assertEquals(await writeLustreKits(app, gleamDir), null, "no Lustre: nothing written");
    assertEquals(await Deno.stat(join(app, ".denext")).catch(() => null), null);

    const lustreJs = join(gleamDir, "build", "dev", "javascript", "lustre");
    await Deno.mkdir(lustreJs, { recursive: true });
    await Deno.writeTextFile(join(lustreJs, "lustre.mjs"), "export {};\n");
    assertEquals(await lustreVersion(gleamDir), "unknown", "no package manifest");
    const pkg = join(gleamDir, "build", "packages", "lustre");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(join(pkg, "gleam.toml"), 'name = "lustre"\nversion = "5.7.1"\n');

    assertEquals(await writeLustreKits(app, gleamDir), "5.7.1");
    const kitPath = join(app, ".denext", "lustre.ts");
    const kit = await Deno.readTextFile(kitPath);
    assertStringIncludes(kit, '"@gleam/lustre/lustre.mjs"');
    assertStringIncludes(kit, 'version: "5.7.1"');
    assertStringIncludes(kit, 'from "denext/gleam"');
    const mtime = (await Deno.stat(kitPath)).mtime;
    await new Promise((r) => setTimeout(r, 20));
    await writeLustreKits(app, gleamDir);
    assertEquals((await Deno.stat(kitPath)).mtime, mtime, "unchanged text is not rewritten");

    // Lustre removed from the project: denext's own kit goes, a file the user wrote stays.
    await Deno.remove(lustreJs, { recursive: true });
    assertEquals(await writeLustreKits(app, gleamDir), null);
    assertEquals(await Deno.stat(kitPath).catch(() => null), null);
    await Deno.writeTextFile(kitPath, "// mine\n");
    await writeLustreKits(app, gleamDir);
    assertEquals(await Deno.readTextFile(kitPath), "// mine\n");
  } finally {
    removeTempDirSync(app);
  }
});

Deno.test('lustreVersion: a manifest version that is not a version is "unknown", never code', async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-ver-" }));
  try {
    const gleamDir = join(app, "gleam");
    const lustreJs = join(gleamDir, "build", "dev", "javascript", "lustre");
    await Deno.mkdir(lustreJs, { recursive: true });
    await Deno.writeTextFile(join(lustreJs, "lustre.mjs"), "export {};\n");
    const pkg = join(gleamDir, "build", "packages", "lustre");
    await Deno.mkdir(pkg, { recursive: true });
    // The kits interpolate the version into a doc comment: a newline or `*/` would end it.
    const hostile = "1.0 */\nglobalThis.pwned = 1;\n/*";
    await Deno.writeTextFile(join(pkg, "gleam.toml"), `name = "lustre"\nversion = "${hostile}"\n`);
    assertEquals(await lustreVersion(gleamDir), "unknown");
    await writeLustreKits(app, gleamDir);
    const kit = await Deno.readTextFile(join(app, ".denext", "lustre.ts"));
    assert(!kit.includes("pwned"), kit);
    await Deno.writeTextFile(join(pkg, "gleam.toml"), 'version = "5.8.0-rc.1+build.2"\n');
    assertEquals(await lustreVersion(gleamDir), "5.8.0-rc.1+build.2");
  } finally {
    removeTempDirSync(app);
  }
});

Deno.test("denext/gleam: importable from client code (no static path to the build plugin)", async () => {
  // a file URL, not a path: `deno info` reads a Windows `C:\…` path as a URL with scheme "c"
  const entry = new URL("../src/gleam.ts", import.meta.url).href;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", entry],
    env: { NO_COLOR: "1" },
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const graph = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    roots: string[];
    modules: Array<{ specifier: string; dependencies?: Array<{ code?: { specifier: string } }> }>;
  };
  // Follow code imports only: `import type` / `typeof import()` never reach a bundle.
  const bySpecifier = new Map(graph.modules.map((m) => [m.specifier, m]));
  const seen = new Set<string>();
  const queue = [...graph.roots];
  while (queue.length) {
    const spec = queue.pop()!;
    if (seen.has(spec)) continue;
    seen.add(spec);
    for (const dep of bySpecifier.get(spec)?.dependencies ?? []) {
      if (dep.code) queue.push(dep.code.specifier);
    }
  }
  const reached = [...seen].filter((s) => s.includes("/src/build/"));
  assertEquals(reached, [], "denext/gleam reaches no build module");
  assert(seen.size > 3, "the walk followed the island's runtime imports");
});

Deno.test("gleam(): the plugin loads its build module on setup and registers the prepare step", async () => {
  let step: PluginPrepareStep | undefined;
  let watch: readonly string[] = [];
  await gleam({ dir: "ui" }).setup({
    projectRoot: "/nowhere",
    addPrepareStep: (s: PluginPrepareStep, o?: { watch?: readonly string[] }) => {
      step = s;
      watch = o?.watch ?? [];
    },
  } as unknown as PluginContext);
  assert(step, "a prepare step");
  assertEquals(watch, ["ui/**/*.gleam", "ui/**/gleam.toml"]);
});
