// src/build/esbuild/mod.ts — denext's vendored esbuild JS API — against a REAL esbuild 0.25.5
// binary (resolved as a build would: ESBUILD_BINARY_PATH, else the toolchain's, else the verified
// npm one): build with plugins (which see this module as `build.esbuild`), incremental contexts,
// transform (the temp-file path for large inputs too), formatMessages, analyzeMetafile, the
// initialize rules, the version handshake, and a CLI that exits without calling stop().

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import * as esbuild from "../src/build/esbuild/mod.ts";
import { ESBUILD_VERSION } from "../src/build/esbuild/version.ts";

/** An import specifier (a URL: a Windows path is no module specifier). */
const MOD = new URL("../src/build/esbuild/mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

Deno.test("esbuild API: version, and a plugin build that sees this module as build.esbuild", async () => {
  assertEquals(esbuild.version, ESBUILD_VERSION);
  assertEquals(ESBUILD_VERSION, "0.25.5");
  let seen = "";
  try {
    const r = await esbuild.build({
      stdin: { contents: "import v from 'virtual:x'; console.log(v)" },
      bundle: true,
      write: false,
      format: "esm",
      metafile: true,
      plugins: [{
        name: "virtual",
        setup(build) {
          seen = build.esbuild.version;
          build.onResolve({ filter: /^virtual:/ }, (a) => ({ path: a.path, namespace: "v" }));
          build.onLoad({ filter: /.*/, namespace: "v" }, () => ({ contents: "export default 42" }));
        },
      }],
    });
    assertEquals(seen, ESBUILD_VERSION);
    assertEquals(r.errors, []);
    assertStringIncludes(r.outputFiles![0].text, "42");
    const report = await esbuild.analyzeMetafile(r.metafile!);
    assertStringIncludes(report, "stdin");
    const bad = await assertRejects(() =>
      esbuild.build({ stdin: { contents: "let = ;" }, write: false, logLevel: "silent" })
    );
    assertStringIncludes((bad as Error).message, "Build failed with 1 error");
  } finally {
    await esbuild.stop();
  }
});

Deno.test("esbuild API: an incremental context rebuilds and disposes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-esbuild-ctx-" });
  try {
    const entry = join(dir, "a.ts");
    await Deno.writeTextFile(entry, "export const a: number = 1;");
    const ctx = await esbuild.context({ entryPoints: [entry], write: false, format: "esm" });
    assertStringIncludes((await ctx.rebuild()).outputFiles![0].text, "a = 1");
    await Deno.writeTextFile(entry, "export const a: number = 2;");
    assertStringIncludes((await ctx.rebuild()).outputFiles![0].text, "a = 2");
    await ctx.dispose();
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("esbuild API: transform (a >1 MiB input goes through a temp file) and formatMessages", async () => {
  try {
    const small = await esbuild.transform("const x: number = 1", { loader: "ts" });
    assertEquals(small.code, "const x = 1;\n");
    const big = "const y: string = " + JSON.stringify("z".repeat(1.5 * 1024 * 1024)) + ";";
    const r = await esbuild.transform(big, { loader: "ts" });
    assert(r.code.startsWith("const y = "));
    const [msg] = await esbuild.formatMessages([{ text: "boom" }], { kind: "error", color: false });
    assertStringIncludes(msg, "boom");
  } finally {
    await esbuild.stop();
  }
});

Deno.test("esbuild API: initialize once, browser-only options refused, sync APIs absent", async () => {
  try {
    await assertRejects(
      () => esbuild.initialize({ wasmURL: "x" }),
      Error,
      "only works in the browser",
    );
    await esbuild.initialize({});
    await assertRejects(() => esbuild.initialize({}), Error, "more than once");
    assertThrows(() => esbuild.buildSync({}), Error, "use the async API");
    assertThrows(() => esbuild.transformSync(""), Error, "use the async API");
  } finally {
    await esbuild.stop();
  }
  // stop() resets initialize: a fresh service may be initialized again.
  await esbuild.initialize({});
  await esbuild.stop();
});

/** Run `code` (importing the API as `esbuild`) in a fresh deno, with `env`. */
async function runScript(code: string, env: Record<string, string> = {}) {
  const dir = await Deno.makeTempDir({ prefix: "denext-esbuild-run-" });
  try {
    const script = join(dir, "main.ts");
    await Deno.writeTextFile(
      script,
      `import * as esbuild from ${JSON.stringify(MOD)};\n${code}\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, script],
      env: { NO_COLOR: "1", ...env },
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(120_000),
    }).output();
    const dec = new TextDecoder();
    return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("esbuild API: a CLI exits on its own after a build — no stop() needed (the idle child is unref'd)", async () => {
  const r = await runScript(
    `const b = await esbuild.build({ stdin: { contents: "export default 1" }, write: false });\n` +
      `console.log("built", b.outputFiles.length);`,
  );
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "built 1");
});

Deno.test({
  name: "esbuild API: ESBUILD_BINARY_PATH to another esbuild version is refused by name",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext-esbuild-fake-" });
    try {
      const fake = join(dir, "esbuild");
      await Deno.writeTextFile(fake, "#!/bin/sh\necho 0.24.2\n");
      await Deno.chmod(fake, 0o755);
      const r = await runScript(`await esbuild.transform("1");`, { ESBUILD_BINARY_PATH: fake });
      assert(r.code !== 0);
      assertStringIncludes(r.stderr, `ESBUILD_BINARY_PATH=${fake} is esbuild "0.24.2"`);
      assertStringIncludes(r.stderr, `needs exactly ${ESBUILD_VERSION}`);
      const missing = await runScript(`await esbuild.transform("1");`, {
        ESBUILD_BINARY_PATH: join(dir, "nope"),
      });
      assertStringIncludes(missing.stderr, "could not be run");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "esbuild API: the binary's own handshake refuses a version mismatch it reports late",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // A binary that passes `--version` but speaks another version on the service protocol: the
    // vendored channel's first-packet check fails every pending call instead of crashing.
    const dir = await Deno.makeTempDir({ prefix: "denext-esbuild-liar-" });
    try {
      const fake = join(dir, "esbuild");
      // The first packet: a little-endian u32 length (6), then "0.24.2".
      await Deno.writeTextFile(
        fake,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${ESBUILD_VERSION}; exit 0; fi\n` +
          `printf '\\006\\000\\000\\0000.24.2'\ncat >/dev/null\n`,
      );
      await Deno.chmod(fake, 0o755);
      const r = await runScript(
        `try { await esbuild.transform("1"); } catch (e) { console.log("rejected:", e.message); }`,
        { ESBUILD_BINARY_PATH: fake },
      );
      assertEquals(r.code, 0, r.stderr);
      assertStringIncludes(r.stdout, "rejected:");
      assertStringIncludes(r.stdout + r.stderr, `does not match binary version "0.24.2"`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
