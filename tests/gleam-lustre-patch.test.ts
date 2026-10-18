// The post-build fixes for Lustre's JavaScript runtimes (src/build/lustre-patch.ts), against the
// files exactly as Lustre 5.7.1 publishes them (tests/fixtures/gleam/lustre-5.7.1; Lustre's `main`
// has the same two files): the server-component runtime's TDZ lines, and the client (SPA)
// runtime's `shutdown` TODO. Each fix matches the code's pattern, so a reformatted or moved copy
// in another version is fixed too; an upstream fix is left alone silently; a file of another shape
// is left alone with one warning. The SPA fix is also run: a timer effect's dispatches stop
// reaching the app once it shuts down. The Gleam build step applies both, for the plugin and
// `denext add gleam:`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  type LustreFixName,
  lustreRuntimePath,
  patchLustreRuntime,
  patchLustreRuntimes,
} from "../src/build/lustre-patch.ts";
import { buildGleam, type GleamHost } from "../src/build/gleam.ts";
import { removeTempDirSync } from "./helpers/temp.ts";

const fixture = (name: string) =>
  Deno.readTextFile(
    fromFileUrl(new URL(`./fixtures/gleam/lustre-5.7.1/${name}`, import.meta.url)),
  );
const SERVER = await fixture("runtime.ffi.mjs");
const SPA = await fixture("spa.ffi.mjs");

/** A Gleam project dir whose build holds Lustre `version`'s runtime files. */
async function project(
  version: string,
  files: Partial<Record<LustreFixName, string>> = { server: SERVER, spa: SPA },
): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-patch-" }));
  for (const [fix, text] of Object.entries(files)) {
    const path = lustreRuntimePath(dir, fix as LustreFixName);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
  await Deno.mkdir(join(dir, "build/dev/javascript/lustre"), { recursive: true });
  await Deno.writeTextFile(join(dir, "build/dev/javascript/lustre/lustre.mjs"), "export {};\n");
  await Deno.mkdir(join(dir, "build/packages/lustre"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "build/packages/lustre/gleam.toml"),
    `name = "lustre"\nversion = "${version}"\n`,
  );
  return dir;
}

/** Run `body` on a project, then remove it. */
async function withProject(
  version: string,
  files: Partial<Record<LustreFixName, string>>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await project(version, files);
  try {
    await body(dir);
  } finally {
    removeTempDirSync(dir);
  }
}

/** The binding that shadows itself (the bug), in any spacing. */
const SHADOWED = /const\s*\{\s*message\s*\}\s*=/;

Deno.test("server runtime: 5.7.1's three TDZ sites are fixed and nothing else; idempotent", async () => {
  await withProject("5.7.1", { server: SERVER }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(await patchLustreRuntime(dir, "server", (m) => warnings.push(m)), "patched");
    const before = SERVER.split("\n");
    const after = (await Deno.readTextFile(lustreRuntimePath(dir))).split("\n");
    assertEquals(after.length, before.length, "line for line");
    const changed = before.flatMap((line, i) => line === after[i] ? [] : [i + 1]);
    assertEquals(changed, [73, 109, 210, 211], "only the three TDZ sites");
    for (const n of [73, 109]) {
      assertEquals(before[n - 1].trim(), "const { message } = message;");
      assert(after[n - 1].trim().startsWith("message = message.message;"));
    }
    assertEquals(
      after[209].trim().split(";")[0],
      "const { message: dispatched } = Result$Ok$0(result)",
    );
    assertEquals(after[210].trim(), "return this.#dispatch(dispatched);");
    assert(!after.some((l) => SHADOWED.test(l)), "the binding no longer shadows itself");

    assertEquals(await patchLustreRuntime(dir, "server", (m) => warnings.push(m)), "already");
    assertEquals(warnings, []);
  });
});

Deno.test("server runtime: another version with the code moved and reformatted is fixed by its pattern", async () => {
  // A later release: four-space indents, tighter braces, a comment above each site, other lines
  // added before them. None of 5.7.1's exact text is left.
  const moved = "// a new header line\n// another\n" +
    SERVER.replaceAll("\n  ", "\n    ")
      .replaceAll("const { message } = message;", "// unwrap\nconst {message} =  message ;")
      .replace("return this.#dispatch(message);", "return this.#dispatch( message );");
  await withProject("5.9.0", { server: moved }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(await patchLustreRuntime(dir, "server", (m) => warnings.push(m)), "patched");
    const after = await Deno.readTextFile(lustreRuntimePath(dir));
    assert(!SHADOWED.test(after));
    assertEquals(after.match(/message = message\.message;/g)?.length, 2);
    assertStringIncludes(after, "return this.#dispatch(dispatched);");
    assertEquals(after.split("\n").length, moved.split("\n").length, "no line added or removed");
    assertEquals(warnings, []);
  });
});

Deno.test("server runtime: a file an earlier denext fixed (other notes) is already fixed", async () => {
  // denext 4.3's exact-text fix, whose notes quote the line they replaced.
  const earlier = SERVER
    .replaceAll(
      "const { message } = message;",
      "message = message.message; // denext: was `const { message } = message` (a TDZ error)",
    )
    .replace(
      "const { message } = Result$Ok$0(result);\n      return this.#dispatch(message);",
      "const { message: dispatched } = Result$Ok$0(result); // denext: a TDZ error as `message`\n" +
        "      return this.#dispatch(dispatched);",
    );
  await withProject("5.7.1", { server: earlier }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(await patchLustreRuntime(dir, "server", (m) => warnings.push(m)), "already");
    assertEquals(await Deno.readTextFile(lustreRuntimePath(dir)), earlier, "untouched");
    assertEquals(warnings, []);
  });
});

Deno.test("server runtime: an upstream fix is left alone without a warning", async () => {
  // lustre-labs/lustre#516's shape: no destructuring of `message` at all.
  const fixed = SERVER
    .replace(
      "const { message } = message;\n      const next = this.#handle_client_message(message);",
      "const next = this.#handle_client_message(message.message);",
    )
    .replace(
      "const { message } = message;\n      const [model, effect] = this.#update(this.#model, message);",
      "const [model, effect] = this.#update(this.#model, message.message);",
    )
    .replace(
      "const { message } = Result$Ok$0(result);\n      return this.#dispatch(message);",
      "return this.#dispatch(Result$Ok$0(result).message);",
    );
  assert(!SHADOWED.test(fixed), "the stand-in has no bug left");
  await withProject("5.8.0", { server: fixed }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(await patchLustreRuntime(dir, "server", (m) => warnings.push(m)), "clean");
    assertEquals(await Deno.readTextFile(lustreRuntimePath(dir)), fixed, "untouched");
    assertEquals(warnings, []);
  });
});

Deno.test("server runtime: a file of another shape is left alone, warned once", async () => {
  const cases = [
    // Not the runtime denext knows (a renamed class).
    SERVER.replace("export class Runtime", "export class ServerRuntime"),
    // The bug in a form the rewrite doesn't know.
    SERVER.replace("const { message } = message;", "const { message } = message.inner;"),
  ];
  for (const text of cases) {
    await withProject("5.7.1", { server: text }, async (dir) => {
      const warnings: string[] = [];
      assertEquals(await patchLustreRuntime(dir, "server", (m) => warnings.push(m)), "skipped");
      assertEquals(await Deno.readTextFile(lustreRuntimePath(dir)), text, "untouched");
      assertEquals(await patchLustreRuntime(dir, "server", (m) => warnings.push(m)), "skipped");
      assertEquals(warnings.length, 1, "one warning per file content");
      assertStringIncludes(warnings[0], "left as it is");
      assertStringIncludes(warnings[0], "defineLustreView");
      assertStringIncludes(warnings[0], "Lustre 5.7.1's runtime.ffi.mjs");
    });
  }
  const none = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-none-" }));
  try {
    assertEquals(await patchLustreRuntime(none, "server"), "none", "no Lustre in the build");
    assertEquals(await patchLustreRuntimes(none), { server: "none", spa: "none" });
  } finally {
    removeTempDirSync(none);
  }
});

Deno.test("SPA runtime: 5.7.1's shutdown TODO becomes a stop; idempotent", async () => {
  await withProject("5.7.1", { spa: SPA }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(await patchLustreRuntime(dir, "spa", (m) => warnings.push(m)), "patched");
    const after = await Deno.readTextFile(lustreRuntimePath(dir, "spa"));
    assert(!after.includes("// TODO"));
    assertStringIncludes(after, "denextStopLustreRuntime(this.#runtime);");
    assert(after.startsWith(SPA.slice(0, SPA.indexOf("// TODO"))), "the code before it is kept");
    assertEquals(await patchLustreRuntime(dir, "spa", (m) => warnings.push(m)), "already");
    assertEquals(warnings, []);
  });
});

Deno.test("SPA runtime: an upstream shutdown is left alone; another shape is warned once", async () => {
  const implemented = SPA.replace("// TODO", "this.#runtime.stop();");
  await withProject("5.8.0", { spa: implemented }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(await patchLustreRuntime(dir, "spa", (m) => warnings.push(m)), "clean");
    assertEquals(warnings, []);
  });
  const other = SPA.replace("export class Spa", "export class ClientApp");
  await withProject("5.8.0", { spa: other }, async (dir) => {
    const warnings: string[] = [];
    assertEquals(await patchLustreRuntime(dir, "spa", (m) => warnings.push(m)), "skipped");
    assertEquals(await patchLustreRuntime(dir, "spa", (m) => warnings.push(m)), "skipped");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "spa.ffi.mjs");
    assertStringIncludes(warnings[0], "keep dispatching");
    assertEquals(await Deno.readTextFile(lustreRuntimePath(dir, "spa")), other, "untouched");
  });
});

/** Stand-ins for the modules `spa.ffi.mjs` imports, with a `Runtime` that counts updates. */
const SPA_SIBLINGS: Record<string, string> = {
  "gleam.mjs": `export const Result$Ok = (v) => ({ ok: true, v });
export const Result$Error = (v) => ({ ok: false, v });`,
  "lustre.mjs": `export const Error$ElementNotFound = (s) => s;
export const Error$NotABrowser = () => "not a browser";`,
  "lustre/runtime/server/runtime.mjs":
    `export const Message$isEffectDispatchedMessage = (m) => m.kind === "dispatch";
export const Message$isEffectEmitEvent = (m) => m.kind === "emit";
export const Message$isSystemRequestedShutdown = (m) => m.kind === "shutdown";`,
  // Shaped like Lustre's client Runtime where it matters: effects get actions whose dispatch calls
  // the runtime's own (public) dispatch, which runs update.
  "lustre/runtime/client/runtime.ffi.mjs": `export const is_browser = () => true;
export class Runtime {
  constructor(root, [model, effects], view, update) {
    this.model = model;
    this.updates = 0;
    this.update = update;
    globalThis.__lustreTestRuntime = this;
    const actions = { dispatch: (message) => this.dispatch(message) };
    effects(actions);
  }
  dispatch(message) {
    this.updates++;
    [this.model] = this.update(this.model, message);
  }
  emit() {}
  unsubscribeAll() { this.unsubscribed = true; }
}`,
};

/** A loaded `spa.ffi.mjs`'s `Spa` class. */
type SpaClass = new (...args: unknown[]) => { send(message: unknown): void };

/** Load `spa` (the file's text) beside the stand-ins. */
async function loadSpa(spa: string): Promise<{ dir: string; Spa: SpaClass }> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-spa-" }));
  const files = { ...SPA_SIBLINGS, "lustre/runtime/client/spa.ffi.mjs": spa };
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  const mod = await import(toFileUrl(join(dir, "lustre/runtime/client/spa.ffi.mjs")).href);
  return { dir, Spa: mod.Spa };
}

/** Start an app whose effect ticks every 2 ms, let it tick, shut it down, count what follows. */
async function ticksAfterShutdown(spaText: string): Promise<{ before: number; after: number }> {
  const { dir, Spa } = await loadSpa(spaText);
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const tick = (actions: { dispatch(m: string): void }) => {
      timer = setInterval(() => actions.dispatch("tick"), 2);
    };
    const app = new Spa({}, [0, tick], (n: number) => [n + 1, null], () => null);
    const runtime = (globalThis as unknown as { __lustreTestRuntime: { updates: number } })
      .__lustreTestRuntime;
    while (runtime.updates < 3) await new Promise((r) => setTimeout(r, 2));
    app.send({ kind: "shutdown" });
    const before = runtime.updates;
    await new Promise((r) => setTimeout(r, 40));
    return { before, after: runtime.updates - before };
  } finally {
    clearInterval(timer);
    removeTempDirSync(dir);
  }
}

Deno.test("SPA runtime: after shutdown a timer effect's dispatches reach the app 0 times", async () => {
  // Unfixed, Lustre's shutdown is a no-op: the timer keeps updating the stopped app.
  const unfixed = await ticksAfterShutdown(SPA);
  assert(unfixed.after > 0, "the unfixed runtime keeps dispatching (what the fix is for)");
  await withProject("5.7.1", { spa: SPA }, async (dir) => {
    assertEquals(await patchLustreRuntime(dir, "spa"), "patched");
    const fixed = await ticksAfterShutdown(await Deno.readTextFile(lustreRuntimePath(dir, "spa")));
    assert(fixed.before >= 3, "it ran before the shutdown");
    assertEquals(fixed.after, 0, "no dispatch reaches the stopped app");
  });
});

Deno.test("buildGleam fixes both Lustre runtimes and writes the kits after the compile", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-build-" }));
  try {
    const gleamDir = join(app, "gleam");
    const source = await project("5.7.1");
    await copy(source, gleamDir);
    removeTempDirSync(source);
    await Deno.writeTextFile(join(gleamDir, "gleam.toml"), 'name = "app"\n');
    const host: GleamHost = {
      locate: () => Promise.resolve("gleam"),
      run: (_cmd, args) =>
        Promise.resolve({ success: true, output: args[0] === "--version" ? "gleam 1.18.1" : "" }),
    };
    const built = await buildGleam(app, {}, host);
    assertEquals(built.status, "built");
    assert(!SHADOWED.test(await Deno.readTextFile(lustreRuntimePath(gleamDir, "server"))));
    assertStringIncludes(
      await Deno.readTextFile(lustreRuntimePath(gleamDir, "spa")),
      "denextStopLustreRuntime(this.#runtime);",
    );
    for (const kit of ["lustre.ts", "lustre-server.ts", "lustre-view.ts"]) {
      assert(await Deno.stat(join(app, ".denext", kit)).then(() => true, () => false), kit);
    }
    const view = await Deno.readTextFile(join(app, ".denext", "lustre-view.ts"));
    assertEquals(view.split("\n")[1], '"use client";', "the island module is a client module");
    assertStringIncludes(view, "@gleam/lustre/lustre/vdom/reconciler.ffi.mjs");
    const server = await Deno.readTextFile(join(app, ".denext", "lustre-server.ts"));
    assertStringIncludes(server, "@gleam/lustre/lustre/runtime/server/runtime.ffi.mjs");
    assertStringIncludes(server, 'import { LustreView } from "./lustre-view.ts";');
  } finally {
    removeTempDirSync(app);
  }
});
