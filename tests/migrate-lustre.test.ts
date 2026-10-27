// `denext migrate --from lustre`: detection, the generated deno.json / denext.config.ts / app/,
// `priv/static/` → `public/`, the won't-migrate report and the `migrate --check` golden report
// (`DENEXT_UPDATE_GOLDEN=1` rewrites it). The Gleam source is never rewritten. The last test
// migrates the fixture, compiles it with a real Gleam (denext's pinned one when it is cached, or
// `DENEXT_TEST_GLEAM`) and exports the page; without a compiler it is skipped, saying why.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";
import { detectLustre, parseGleamToml, startSelector } from "../src/build/migrate-lustre.ts";
import { gleamToolchainStatus } from "../src/build/gleam-toolchain.ts";
import { runBounded } from "./helpers/bounded-command.ts";

type Tree = Record<string, string>;

const REPO = fromFileUrl(new URL("..", import.meta.url));
const GOLDEN = fromFileUrl(new URL("./fixtures/migrate-lustre/lustre.check.json", import.meta.url));

async function withTree<T>(files: Tree, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_migrate_lustre_" }));
  try {
    for (const [rel, body] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), body);
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const read = (dir: string, rel: string) => Deno.readTextFile(join(dir, rel));
const exists = (dir: string, rel: string) =>
  Deno.stat(join(dir, rel)).then(() => true, () => false);

const COUNTER_GLEAM = `import gleam/int
import lustre
import lustre/attribute
import lustre/effect.{type Effect}
import lustre/element.{type Element}
import lustre/element/html
import lustre/event
import widget

pub fn main() -> Nil {
  let assert Ok(_) = widget.register()
  let app = lustre.application(init, update, view)
  let assert Ok(_) = lustre.start(app, "#app", 0)
  Nil
}

pub type Msg {
  Incr
  Decr
  Loaded(Int)
}

fn init(start: Int) -> #(Int, Effect(Msg)) {
  #(start, effect.from(fn(dispatch) { dispatch(Loaded(10)) }))
}

fn update(count: Int, msg: Msg) -> #(Int, Effect(Msg)) {
  case msg {
    Incr -> #(count + 1, effect.none())
    Decr -> #(count - 1, effect.none())
    Loaded(n) -> #(n, effect.none())
  }
}

fn view(count: Int) -> Element(Msg) {
  html.div([attribute.class("counter")], [
    html.button([event.on_click(Decr)], [html.text("-")]),
    html.span([attribute.class("count")], [html.text(int.to_string(count))]),
    html.button([event.on_click(Incr)], [html.text("+")]),
    element.element("lustre-greeting", [], []),
  ])
}
`;

const WIDGET_GLEAM = `import lustre
import lustre/effect
import lustre/element/html

pub fn register() {
  let component =
    lustre.component(
      fn(_) { #("hello", effect.none()) },
      fn(model, _msg: Nil) { #(model, effect.none()) },
      fn(model) { html.p([], [html.text(model)]) },
      [],
    )
  lustre.register(component, "lustre-greeting")
}
`;

const LIVE_GLEAM = `import lustre
import lustre/element.{type Element}
import lustre/element/html
import lustre/server_component

pub fn app() -> lustre.App(Nil, Int, Nil) {
  lustre.simple(fn(_) { 0 }, fn(count, _msg) { count }, fn(_count) { html.p([], [html.text("live")]) })
}

pub fn mount() -> Element(msg) {
  server_component.element([server_component.route("/live")], [])
}
`;

/** A Lustre app as lustre_dev_tools sets one up: a counter with an effect, a component, a server component. */
const LUSTRE: Tree = {
  "gleam.toml": `name = "counter_app"
version = "1.0.0"
target = "javascript"

[dependencies]
gleam_stdlib = ">= 1.0.5 and < 2.0.0"
lustre = ">= 5.7.1 and < 6.0.0"

[javascript]
typescript_declarations = true
`,
  "src/counter_app.gleam": COUNTER_GLEAM,
  "src/widget.gleam": WIDGET_GLEAM,
  "src/live.gleam": LIVE_GLEAM,
  "priv/static/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>\n",
  "priv/static/img/bg.txt": "bg\n",
  ".gitignore": "*.beam\n/build\nerl_crash.dump\n",
};

/** The same app with what does not migrate: Erlang code, a server project, dev-tools settings. */
const LUSTRE_FULL: Tree = {
  ...LUSTRE,
  "gleam.toml": `name = "counter_app"
version = "1.0.0"
target = "javascript" # lustre_dev_tools builds the browser bundle

[dependencies]
gleam_stdlib = ">= 1.0.5 and < 2.0.0"
lustre = ">= 5.7.1 and < 6.0.0"
mist = ">= 5.0.0 and < 6.0.0"

[dev-dependencies]
lustre_dev_tools = ">= 2.0.0 and < 3.0.0"

[tools.lustre.html]
title = "Counter (dev tools)"

[tools.lustre.dev]
proxy = { from = "/api", to = "http://localhost:8000/api" }
`,
  "index.html": "<!doctype html><html><head><title>Counter</title></head>" +
    '<body><div id="app"></div><script type="module" src="/priv/static/counter_app.mjs"></script>' +
    "</body></html>\n",
  "src/counter_app.css": ".counter { display: flex; }\n",
  "src/ffi.erl": "-module(ffi).\n",
  "src/clock.gleam": '@external(erlang, "os", "system_time")\npub fn now() -> Int\n',
  "priv/static/counter_app.mjs": "// lustre_dev_tools bundle\n",
  "server/gleam.toml": 'name = "server"\nversion = "1.0.0"\n',
};

Deno.test("parseGleamToml / startSelector: the keys migrate reads", () => {
  const toml = parseGleamToml(LUSTRE_FULL["gleam.toml"]);
  assertEquals(toml.get("")!.get("name"), "counter_app");
  assertEquals(toml.get("")!.get("target"), "javascript");
  assert(toml.get("dependencies")!.has("lustre"));
  assertEquals(toml.get("tools.lustre.html")!.get("title"), "Counter (dev tools)");
  assertEquals(startSelector(COUNTER_GLEAM), "#app");
  assertEquals(startSelector(`lustre.start(app, ".root", Nil)`), ".root");
  assertEquals(startSelector(`lustre.start(app(), "#root", Nil)`), "#root");
  assertEquals(startSelector("pub fn main() { Nil }"), null);
});

Deno.test("detectLustre: a JavaScript-target Lustre app, dev tools alone, and not-Lustre", async () => {
  await withTree(
    LUSTRE,
    async (dir) => assertEquals((await detectLustre(dir))?.name, "counter_app"),
  );
  // No target, but lustre_dev_tools (which always builds JavaScript).
  const devTools =
    `name = "x"\n[dependencies]\nlustre = "5"\n[dev-dependencies]\nlustre_dev_tools = "2"\n`;
  await withTree({ "gleam.toml": devTools }, async (dir) => assert(await detectLustre(dir)));
  // An Erlang-target Gleam app, a Gleam app without Lustre, no gleam.toml.
  const erlang = `name = "x"\n[dependencies]\nlustre = "5"\n`;
  await withTree(
    { "gleam.toml": erlang },
    async (dir) => assertEquals(await detectLustre(dir), null),
  );
  const plain = `name = "x"\ntarget = "javascript"\n[dependencies]\ngleam_stdlib = "1"\n`;
  await withTree(
    { "gleam.toml": plain },
    async (dir) => assertEquals(await detectLustre(dir), null),
  );
  await withTree({ "deno.json": "{}" }, async (dir) => assertEquals(await detectLustre(dir), null));
});

Deno.test("migrate: a Lustre app — deno.json, gleam() config, an island running main, priv/static", async () => {
  await withTree(LUSTRE, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(r.kind, "lustre");
    const l = r.lustre!;
    assertEquals([l.package, l.entry, l.selector, l.staticMoved], [
      "counter_app",
      "src/counter_app.gleam",
      "#app",
      2,
    ]);
    // The Gleam source is untouched; it stays where it was.
    assertEquals(await read(dir, "src/counter_app.gleam"), COUNTER_GLEAM);
    assertEquals(await read(dir, "gleam.toml"), LUSTRE["gleam.toml"]);

    const deno = JSON.parse(await read(dir, "deno.json"));
    assertEquals(deno.imports["@gleam/"], "./build/dev/javascript/");
    assertStringIncludes(deno.imports["denext/gleam"], "src/gleam.ts");
    assert(deno.tasks.dev && deno.tasks.build && deno.tasks.start);
    assertStringIncludes(await read(dir, "denext.config.ts"), "plugins: [gleam()]");
    assertStringIncludes(await read(dir, ".gitignore"), "build/");

    const island = await read(dir, "app/lustre-app.tsx");
    assert(island.startsWith(`"use client";\n`));
    assertStringIncludes(island, `import { main } from "@gleam/counter_app/counter_app.mjs";`);
    assertStringIncludes(island, `<div id="app" />`);
    assertStringIncludes(await read(dir, "app/page.tsx"), "<LustreApp />");
    assertStringIncludes(await read(dir, "app/layout.tsx"), `title: "counter_app"`);

    // priv/static → public, and priv/ is gone once empty.
    assert(await exists(dir, "public/logo.svg"));
    assert(await exists(dir, "public/img/bg.txt"));
    assert(!await exists(dir, "priv"));
    // Components and server components are pointed at, not rewritten.
    assert(l.review.some((f) => f.item === "src/live.gleam" && /defineLustreView/.test(f.reason)));
    assert(l.review.some((f) => f.item === "src/widget.gleam" && /lustreElement/.test(f.reason)));
    assertEquals(l.wontMigrate, []);

    // A re-run is idempotent: the generated files are rewritten as they were.
    const again = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(again.kind, "lustre");
    assertEquals(await read(dir, "app/lustre-app.tsx"), island);
  });
});

Deno.test("migrate: a hand-written page and config are kept and reported", async () => {
  const kept = {
    ...LUSTRE,
    "app/page.tsx": "export default function Mine() { return <p />; }\n",
    "denext.config.ts": "export default {};\n",
  };
  await withTree(kept, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(await read(dir, "app/page.tsx"), kept["app/page.tsx"]);
    assertEquals(await read(dir, "denext.config.ts"), kept["denext.config.ts"]);
    const items = r.lustre!.review.map((f) => f.item);
    assert(items.includes("app/page.tsx") && items.includes("denext.config.ts"), items.join());
  });
});

Deno.test("migrate: a public/ file already there is never overwritten by priv/static", async () => {
  const mine = new Uint8Array([0, 1, 2, 3]);
  await withTree({ ...LUSTRE, "priv/static/favicon.ico": "lustre's icon\n" }, async (dir) => {
    await Deno.mkdir(join(dir, "public"), { recursive: true });
    await Deno.writeFile(join(dir, "public", "favicon.ico"), mine);
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(
      await Deno.readFile(join(dir, "public", "favicon.ico")),
      mine,
      "kept byte for byte",
    );
    assertEquals(await read(dir, "priv/static/favicon.ico"), "lustre's icon\n", "left in place");
    assert(
      r.lustre!.wontMigrate.some((f) =>
        f.item === "priv/static/favicon.ico" && /already exists; merge by hand/.test(f.reason)
      ),
      JSON.stringify(r.lustre!.wontMigrate),
    );
    // The rest still moved.
    assert(await exists(dir, "public/logo.svg"));
  });
});

Deno.test("migrate: a main mounting on another kind of selector, or none found, is reported", async () => {
  const other = COUNTER_GLEAM.replace(`"#app"`, `"body > main"`);
  await withTree({ ...LUSTRE, "src/counter_app.gleam": other }, async (dir) => {
    const r = await migrateProject(dir, { denextLocalPath: REPO });
    assertEquals(r.lustre!.selector, "body > main");
    assert(r.lustre!.review.some((f) => f.item === "src/counter_app.gleam"));
    assertStringIncludes(await read(dir, "app/lustre-app.tsx"), `<div id="app" />`);
  });
  const cls = COUNTER_GLEAM.replace(`"#app"`, `".root"`);
  await withTree({ ...LUSTRE, "src/counter_app.gleam": cls }, async (dir) => {
    await migrateProject(dir, { denextLocalPath: REPO });
    assertStringIncludes(await read(dir, "app/lustre-app.tsx"), `<div className="root" />`);
  });
});

/** The check report without what varies per run (the temp directory, the version). */
function stable(report: Record<string, unknown>): Record<string, unknown> {
  const { target: _t, denext: _d, ...rest } = report;
  return JSON.parse(JSON.stringify(rest).replaceAll(JSON.stringify(REPO).slice(1, -1), "<repo>/"));
}

Deno.test("migrate --check: a Lustre app — golden report, Erlang code and dev-tools settings; writes nothing", async () => {
  await withTree(LUSTRE_FULL, async (dir) => {
    const report = await checkMigration(dir, { denextLocalPath: REPO });
    assertEquals(report.source, "lustre");
    assertEquals(report.verdict, "review");
    const actual = JSON.stringify(stable(report as unknown as Record<string, unknown>), null, 2) +
      "\n";
    if (Deno.env.get("DENEXT_UPDATE_GOLDEN") === "1") await Deno.writeTextFile(GOLDEN, actual);
    assertEquals(actual, await Deno.readTextFile(GOLDEN));
    // Nothing was written or moved.
    assert(!await exists(dir, "deno.json"));
    assert(!await exists(dir, "app"));
    assert(await exists(dir, "priv/static/logo.svg"));
  });
});

Deno.test("migrate --from lustre on a directory with no Lustre app (or no entry) is blocked", async () => {
  await withTree({ "deno.json": "{}" }, async (dir) => {
    const report = await checkMigration(dir, { from: "lustre" });
    assertEquals(report.verdict, "blocked");
    assertStringIncludes(report.error!, "no Lustre app");
  });
  const noMain = { "gleam.toml": LUSTRE["gleam.toml"], "src/counter_app.gleam": "pub fn x() {}\n" };
  await withTree(noMain, async (dir) => {
    const report = await checkMigration(dir, {});
    assertEquals(report.verdict, "blocked");
    assertStringIncludes(report.error!, "pub fn main()");
  });
});

/** A real `gleam` for the build test: `DENEXT_TEST_GLEAM`, else denext's pinned one when cached. */
async function realGleam(): Promise<{ bin: string | null; why: string }> {
  const env = Deno.env.get("DENEXT_TEST_GLEAM");
  if (env) return { bin: env, why: "" };
  const status = await gleamToolchainStatus();
  if (status.state === "cached" && status.path) return { bin: status.path, why: "" };
  return {
    bin: null,
    why: `no Gleam compiler (${status.detail}): run \`denext toolchain install --with gleam\` ` +
      "or set DENEXT_TEST_GLEAM to compile and export the migrated app",
  };
}

const GLEAM = await realGleam();
if (!GLEAM.bin) console.warn(`migrate-lustre build test skipped: ${GLEAM.why}`);

Deno.test({
  name: "migrate --from lustre: the migrated app compiles with gleam() and exports its page",
  ignore: GLEAM.bin === null,
  sanitizeResources: false,
}, async () => {
  await withTree(LUSTRE, async (dir) => {
    await migrateProject(dir, { denextLocalPath: REPO });
    // Lustre comes from Hex on the first compile, so this needs the network once.
    // The CLI, as a user runs it: the export resolves `@gleam/` through the app's own import map.
    const out = await runBounded(Deno.execPath(), [
      "run",
      "-A",
      join(REPO, "cli.ts"),
      "export",
      dir,
    ], {
      cwd: dir,
      env: { DENEXT_GLEAM: GLEAM.bin! },
      timeoutMs: 600_000,
    });
    assert(out.success, out.output);
    for (const kit of ["lustre.ts", "lustre-server.ts", "lustre-view.ts"]) {
      assert(await exists(dir, `.denext/${kit}`), kit);
    }
    assert(await exists(dir, "build/dev/javascript/counter_app/counter_app.mjs"));
    const html = await read(dir, "out/index.html");
    assertStringIncludes(html, "<title>counter_app</title>");
    assertStringIncludes(html, `<div id="app"></div>`);
    assertStringIncludes(html, "/_denext/", "the page loads the island's client JS");
    assert(await exists(dir, "out/logo.svg"), "public/ is exported");
    // The island's chunk carries the Gleam app: its view, its component's tag.
    let js = "";
    for await (const e of Deno.readDir(join(dir, "out", "_denext", "client"))) {
      if (e.isFile && e.name.endsWith(".js")) js += await read(dir, `out/_denext/client/${e.name}`);
    }
    assertStringIncludes(js, "lustre-greeting");
  });
});
