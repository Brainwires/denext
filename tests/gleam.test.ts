// Gleam interop (src/build/gleam.ts, `denext/gleam`, `denext add gleam:<package>`). The fixture
// under tests/fixtures/gleam/greeter is real `gleam build --target javascript` output (Gleam
// 1.15.0, `typescript_declarations = true`), committed as Gleam wrote it: these tests type-check
// TypeScript against it under Deno, drive the plugin and `denext add gleam:` through a fake
// `gleam`, and — when a real `gleam` is installed — compile a project end to end.

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  addGleamPackages,
  buildGleam,
  type GleamHost,
  gleamPlugin,
  type GleamRunner,
  patchGleamTypeRefs,
} from "../src/build/gleam.ts";
import type { PluginContext, PluginPrepareStep } from "../src/plugin/mod.ts";
import { removeTempDirSync } from "./helpers/temp.ts";
import { DenoToolchainDownloadError, DenoToolchainHashError } from "../src/build/deno-toolchain.ts";
import { ensureGleamToolchain, GLEAM_PREFETCH } from "../src/build/gleam-toolchain.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/gleam/greeter", import.meta.url));

/** A temp app holding a copy of the fixture project at `<app>/<dir>`. */
async function appWithFixture(dir = "gleam"): Promise<string> {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-gleam-" }));
  await copy(FIXTURE, join(app, dir));
  return app;
}

/** `deno check` `source` in `app` (whose deno.json maps `@gleam/`); its diagnostics. */
async function check(app: string, source: string): Promise<{ ok: boolean; out: string }> {
  await Deno.writeTextFile(join(app, "use.ts"), source);
  const out = await new Deno.Command(Deno.execPath(), {
    // `--reload`: the unpatched check of the same files must not leave its module cache behind.
    args: ["check", "--reload", "--config", join(app, "deno.json"), join(app, "use.ts")],
    cwd: app,
    env: { NO_COLOR: "1" },
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  return { ok: out.success, out: text };
}

const USE = `import { count, greet, safe_div } from "@gleam/greeter/greeter.mjs";
import { area, Circle } from "@gleam/greeter/shapes/geometry.mjs";
import { List, Ok, type Result } from "@gleam/greeter/gleam.mjs";
const hello: string = greet("Deno");
const n: number = count(List.fromArray([1, 2, 3]));
const r: Result<number, string> = safe_div(7, 2);
const a: number = area(new Circle(2.0));
export const out = [hello, n, r instanceof Ok ? r[0] : null, a];
`;

Deno.test({
  name: "Gleam output type-checks under Deno once patched (and not before)",
  sanitizeResources: false,
}, async () => {
  const app = await appWithFixture();
  try {
    await Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({ imports: { "@gleam/": "./gleam/build/dev/javascript/" } }),
    );
    // As Gleam writes it: `prelude.mjs` / `gleam.mjs` carry no type reference, so Deno infers
    // them from the JavaScript and the package's declarations collide with themselves.
    const before = await check(app, USE);
    assert(!before.ok, "the unpatched output does not type-check under Deno");
    assertStringIncludes(before.out, "TS2308");

    const js = join(app, "gleam", "build", "dev", "javascript");
    assertEquals(await patchGleamTypeRefs(js), 2, "prelude.mjs and greeter/gleam.mjs");
    assertEquals(await patchGleamTypeRefs(js), 0, "idempotent");
    assertMatch(
      await Deno.readTextFile(join(js, "prelude.mjs")),
      /^\/\/\/ <reference types="\.\/prelude\.d\.mts" \/>\n/,
    );
    const after = await check(app, USE);
    assert(after.ok, after.out);
    // …and the types are Gleam's: a wrong argument is an error.
    const wrong = await check(
      app,
      `import { greet } from "@gleam/greeter/greeter.mjs";\ngreet(42);\n`,
    );
    assert(!wrong.ok);
    assertStringIncludes(wrong.out, "TS2345");
    // It runs, too.
    const mod = await import(toFileUrl(join(js, "greeter", "greeter.mjs")).href);
    assertEquals(mod.greet("Gleam"), "Hello, Gleam!");
  } finally {
    removeTempDirSync(app);
  }
});

/**
 * A fake `gleam`: records its calls; `build` copies the fixture's output into place. `locate`
 * answers the `gleam` option or `"gleam"`, or throws `unavailable` (no compiler to be had).
 */
function fakeGleam(
  opts: { installed?: boolean; buildFails?: boolean; unavailable?: Error } = {},
): GleamHost & { calls: string[] } {
  const calls: string[] = [];
  const locate = (o: { gleam?: string }) =>
    opts.unavailable ? Promise.reject(opts.unavailable) : Promise.resolve(o.gleam ?? "gleam");
  const run: GleamRunner = async (cmd, args, cwd) => {
    calls.push(`${cmd} ${args.join(" ")} @${cwd}`);
    if (opts.installed === false) return { success: false, output: "" };
    if (args[0] === "--version") return { success: true, output: "gleam 1.15.0\n" };
    if (args[0] === "build") {
      if (opts.buildFails) return { success: false, output: "error: Unknown variable\n" };
      await copy(join(FIXTURE, "build"), join(cwd, "build"), { overwrite: true });
      return { success: true, output: "Compiled in 0.01s" };
    }
    return { success: true, output: "" };
  };
  return { run, locate, calls };
}

Deno.test("buildGleam: no project, no gleam, a failed and a good build", async () => {
  const empty = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-gleam-" }));
  const app = await appWithFixture();
  try {
    await Deno.remove(join(app, "gleam", "build"), { recursive: true });
    assertEquals((await buildGleam(empty, {}, fakeGleam())).status, "no-project");
    assertEquals(
      (await buildGleam(app, {}, fakeGleam({ installed: false }))).status,
      "missing",
    );
    const failed = await buildGleam(app, {}, fakeGleam({ buildFails: true }));
    assertEquals(failed.status, "failed");
    assertStringIncludes((failed as { output: string }).output, "Unknown variable");
    const good = fakeGleam();
    const built = await buildGleam(app, {}, good);
    assertEquals(built.status, "built");
    assertEquals((built as { patched: number }).patched, 2, "the output is patched for Deno");
    assertEquals(good.calls.at(-1), `gleam build --target javascript @${join(app, "gleam")}`);
    // A `gleam.toml` at the app root is the project; `dir` overrides the lookup.
    await copy(join(app, "gleam", "gleam.toml"), join(app, "gleam.toml"));
    assertEquals((await buildGleam(app, {}, good)).dir, app);
    assertEquals((await buildGleam(app, { dir: "gleam" }, good)).dir, join(app, "gleam"));
  } finally {
    removeTempDirSync(empty);
    removeTempDirSync(app);
  }
});

/** Run the plugin's prepare step for `app`. */
function prepareStep(plugin: ReturnType<typeof gleamPlugin>, app: string) {
  let step: PluginPrepareStep | undefined;
  let watch: readonly string[] = [];
  plugin.setup({
    projectRoot: app,
    addPrepareStep: (s: PluginPrepareStep, o?: { watch?: readonly string[] }) => {
      step = s;
      watch = o?.watch ?? [];
    },
  } as unknown as PluginContext);
  return { run: () => step!({ projectRoot: app, outDir: join(app, ".denext") } as never), watch };
}

Deno.test("gleam() plugin: compiles on prepare, keeps old output without a compiler, fails on a compile error", async () => {
  const app = await appWithFixture();
  const warn = console.warn;
  const log = console.log;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  console.log = () => {};
  try {
    const missing = prepareStep(gleamPlugin({}, fakeGleam({ installed: false })), app);
    assertEquals(missing.watch, ["**/*.gleam", "**/gleam.toml"]);
    await missing.run();
    await missing.run();
    assertEquals(warnings.length, 1, "the fixture has compiled output: warned once, kept");
    assertStringIncludes(warnings[0], "keeping the last compiled output");
    assertStringIncludes(warnings[0], "did not run");

    // Offline before the first download, and nothing compiled yet: a clear error, not a skip.
    const offline = fakeGleam({
      unavailable: new DenoToolchainDownloadError(
        `denext: could not download … Are you offline? Run \`${GLEAM_PREFETCH}\` once`,
      ),
    });
    const fresh = await appWithFixture("gleam");
    try {
      await Deno.remove(join(fresh, "gleam", "build"), { recursive: true });
      await assertRejects(
        () => Promise.resolve(prepareStep(gleamPlugin({}, offline), fresh).run()),
        Error,
        GLEAM_PREFETCH,
      );
    } finally {
      removeTempDirSync(fresh);
    }
    // A download that failed its SHA-256 check fails the step even with output to keep.
    const tampered = fakeGleam({ unavailable: new DenoToolchainHashError("REFUSING gleam") });
    await assertRejects(
      () => Promise.resolve(prepareStep(gleamPlugin({}, tampered), app).run()),
      Error,
      "REFUSING gleam",
    );
    assertEquals(warnings.length, 1);

    const broken = prepareStep(gleamPlugin({}, fakeGleam({ buildFails: true })), app);
    await assertRejects(() => Promise.resolve(broken.run()), Error, "Unknown variable");

    const good = fakeGleam();
    await prepareStep(gleamPlugin({ dir: "gleam/" }, good), app).run();
    assert(good.calls.some((c) => c.startsWith("gleam build")));
    assertEquals(prepareStep(gleamPlugin({ dir: "gleam/" }, good), app).watch, [
      "gleam/**/*.gleam",
      "gleam/**/gleam.toml",
    ]);
  } finally {
    console.warn = warn;
    console.log = log;
    removeTempDirSync(app);
  }
});

Deno.test("denext add gleam:<package>: project, package, build and the @gleam/ import map", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-gleam-add-" }));
  const lines: string[] = [];
  const io = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`!${l}`) };
  try {
    await Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({ name: "@acme/My-App", imports: { "zod": "npm:zod@3" } }),
    );
    const fake = fakeGleam();
    assert(await addGleamPackages(app, ["gleam_json"], {}, io, fake), lines.join("\n"));
    const toml = await Deno.readTextFile(join(app, "gleam", "gleam.toml"));
    assertStringIncludes(toml, 'name = "my_app"');
    assertStringIncludes(toml, 'target = "javascript"');
    assertStringIncludes(toml, "typescript_declarations = true");
    assert(fake.calls.includes(`gleam add gleam_json @${join(app, "gleam")}`));
    const config = JSON.parse(await Deno.readTextFile(join(app, "deno.json")));
    assertEquals(config.imports, {
      "zod": "npm:zod@3",
      "@gleam/": "./gleam/build/dev/javascript/",
    });
    assertStringIncludes(await Deno.readTextFile(join(app, ".gitignore")), "gleam/build/");
    assert(lines.some((l) => l.includes("@gleam/<package>/<module>.mjs")));

    // Without gleam it says so and changes nothing.
    lines.length = 0;
    const other = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-gleam-add-" }));
    try {
      assert(!await addGleamPackages(other, ["x"], {}, io, fakeGleam({ installed: false })));
      assertStringIncludes(lines[0], "no Gleam compiler");
      assertEquals([...Deno.readDirSync(other)], []);
    } finally {
      removeTempDirSync(other);
    }
  } finally {
    removeTempDirSync(app);
  }
});

Deno.test("denext add gleam: never shadows a deno.jsonc with a new deno.json", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-gleam-jsonc-" }));
  const lines: string[] = [];
  const io = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`!${l}`) };
  try {
    // Deno reads deno.json before deno.jsonc: a new deno.json would replace the whole config.
    const jsonc = '{\n  // the config\n  "tasks": { "dev": "denext dev" }\n}\n';
    await Deno.writeTextFile(join(app, "deno.jsonc"), jsonc);
    assert(await addGleamPackages(app, ["gleam_json"], {}, io, fakeGleam()), lines.join("\n"));
    assertEquals(await Deno.stat(join(app, "deno.json")).catch(() => null), null);
    assertEquals(await Deno.readTextFile(join(app, "deno.jsonc")), jsonc);
    assert(lines.some((l) => l.includes('add "@gleam/": "./gleam/build/dev/javascript/"')));
  } finally {
    removeTempDirSync(app);
  }
});

Deno.test("denext add gleam: refuses a name that is not a Hex package before running gleam", async () => {
  const app = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-gleam-name-" }));
  const lines: string[] = [];
  const io = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(`!${l}`) };
  try {
    for (const bad of [["--dev"], ["-h"], ["lustre", "../x"], ["Lustre"], []]) {
      const fake = fakeGleam();
      lines.length = 0;
      assert(!await addGleamPackages(app, bad, {}, io, fake), JSON.stringify(bad));
      assertEquals(fake.calls, [], `${JSON.stringify(bad)}: gleam never ran`);
      assertStringIncludes(lines.join("\n"), "Hex package");
    }
    assertEquals([...Deno.readDirSync(app)], [], "nothing was written");
    const fake = fakeGleam();
    assert(await addGleamPackages(app, ["lustre@5", "gleam_json@3.0.1"], {}, io, fake));
    assert(fake.calls.some((c) => c.startsWith("gleam add lustre@5 gleam_json@3.0.1 ")));
  } finally {
    removeTempDirSync(app);
  }
});

/** Where DENEXT_TEST_GLEAM_DOWNLOAD=1 caches the pinned Gleam for this file (removed at unload). */
const DOWNLOAD_ROOT = Deno.env.get("DENEXT_TEST_GLEAM_DOWNLOAD") === "1"
  ? await Deno.makeTempDir({ prefix: "denext-gleam-pinned-" })
  : null;
if (DOWNLOAD_ROOT) {
  globalThis.addEventListener("unload", () => removeTempDirSync(DOWNLOAD_ROOT));
}

/**
 * A real `gleam`, or null: with DENEXT_TEST_GLEAM_DOWNLOAD=1 the pinned one, downloaded and
 * verified into a temp cache (the path users take); else `DENEXT_TEST_GLEAM`, else `gleam` on PATH.
 */
async function realGleam(): Promise<string | null> {
  if (DOWNLOAD_ROOT) {
    return (await ensureGleamToolchain({ cacheRoot: DOWNLOAD_ROOT, env: () => undefined })).gleam;
  }
  const bin = Deno.env.get("DENEXT_TEST_GLEAM") ?? "gleam";
  try {
    const out = await new Deno.Command(bin, { args: ["--version"] }).output();
    return out.success ? bin : null;
  } catch {
    return null;
  }
}

const GLEAM = await realGleam();

Deno.test({
  name: "gleam() with a real toolchain: compile a project and import it typed",
  ignore: GLEAM === null,
  sanitizeResources: false,
}, async () => {
  const app = await appWithFixture();
  try {
    await Deno.remove(join(app, "gleam", "build"), { recursive: true });
    await Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({ imports: { "@gleam/": "./gleam/build/dev/javascript/" } }),
    );
    const built = await buildGleam(app, { gleam: GLEAM! });
    assertEquals(built.status, "built", JSON.stringify(built));
    const result = await check(app, USE);
    assert(result.ok, result.out);
  } finally {
    removeTempDirSync(app);
  }
});
