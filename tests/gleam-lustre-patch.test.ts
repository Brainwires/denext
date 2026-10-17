// The post-build fix for Lustre 5.7.1's server-component runtime (src/build/lustre-patch.ts),
// against the file exactly as Lustre publishes it (tests/fixtures/gleam/lustre-5.7.1): applied only
// to that version's exact bytes, idempotent, nothing but the three lines changed, and anything
// else (another version, an upstream fix, a hand edit) left alone with one warning. The Gleam
// build step runs it beside the `.d.mts` reference fix, for the plugin and `denext add gleam:`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { copy } from "@std/fs/copy";
import { fromFileUrl, join } from "@std/path";
import {
  KNOWN_LUSTRE_RUNTIMES,
  lustreServerRuntimePath,
  patchLustreServerRuntime,
} from "../src/build/lustre-patch.ts";
import { buildGleam, type GleamHost } from "../src/build/gleam.ts";
import { removeTempDirSync } from "./helpers/temp.ts";

const ORIGINAL = fromFileUrl(
  new URL("./fixtures/gleam/lustre-5.7.1/runtime.ffi.mjs", import.meta.url),
);

const sha256 = async (text: string) =>
  encodeHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** A Gleam project dir whose build holds Lustre `version`'s server runtime (`text`). */
async function project(version: string, text?: string): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-patch-" }));
  const runtime = lustreServerRuntimePath(dir);
  await Deno.mkdir(join(runtime, ".."), { recursive: true });
  await Deno.writeTextFile(runtime, text ?? await Deno.readTextFile(ORIGINAL));
  await Deno.writeTextFile(join(dir, "build/dev/javascript/lustre/lustre.mjs"), "export {};\n");
  await Deno.mkdir(join(dir, "build/packages/lustre"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "build/packages/lustre/gleam.toml"),
    `name = "lustre"\nversion = "${version}"\n`,
  );
  return dir;
}

Deno.test("the fixture is Lustre 5.7.1's runtime as published (the hash the patch trusts)", async () => {
  const known = KNOWN_LUSTRE_RUNTIMES.find((k) => k.version === "5.7.1")!;
  assertEquals(await sha256(await Deno.readTextFile(ORIGINAL)), known.original);
});

Deno.test("patchLustreServerRuntime: fixes the TDZ lines of 5.7.1 and nothing else; idempotent", async () => {
  const dir = await project("5.7.1");
  try {
    const warnings: string[] = [];
    assertEquals(await patchLustreServerRuntime(dir, (m) => warnings.push(m)), "patched");
    const before = (await Deno.readTextFile(ORIGINAL)).split("\n");
    const after = (await Deno.readTextFile(lustreServerRuntimePath(dir))).split("\n");
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
    // The binding no longer shadows itself anywhere.
    assert(!after.some((l) => /const \{ message \} = (message|Result\$Ok\$0\(result\));/.test(l)));

    assertEquals(await patchLustreServerRuntime(dir, (m) => warnings.push(m)), "already");
    assertEquals(warnings, []);
  } finally {
    removeTempDirSync(dir);
  }
});

Deno.test("patchLustreServerRuntime: another version, an upstream fix or a hand edit is left alone, warned once", async () => {
  const original = await Deno.readTextFile(ORIGINAL);
  const cases = [
    // A version denext does not know, even with the same bug.
    { version: "5.8.0", text: original },
    // 5.7.1's version string, but different bytes (an upstream fix, a hand edit).
    { version: "5.7.1", text: original.replace("const { message } = message;", "/* fixed */") },
    { version: "5.7.1", text: original + "\n// one more line\n" },
  ];
  for (const { version, text } of cases) {
    const dir = await project(version, text);
    try {
      const warnings: string[] = [];
      assertEquals(await patchLustreServerRuntime(dir, (m) => warnings.push(m)), "skipped");
      assertEquals(await Deno.readTextFile(lustreServerRuntimePath(dir)), text, "untouched");
      assertEquals(await patchLustreServerRuntime(dir, (m) => warnings.push(m)), "skipped");
      assertEquals(warnings.length, 1, "one warning per file content");
      assertStringIncludes(warnings[0], "left as it is");
    } finally {
      removeTempDirSync(dir);
    }
  }
  const none = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-lustre-none-" }));
  try {
    assertEquals(await patchLustreServerRuntime(none), "none", "no Lustre in the build");
  } finally {
    removeTempDirSync(none);
  }
});

Deno.test("buildGleam patches Lustre's server runtime and writes the kits after the compile", async () => {
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
    const known = KNOWN_LUSTRE_RUNTIMES[0];
    assertEquals(
      await sha256(await Deno.readTextFile(lustreServerRuntimePath(gleamDir))),
      known.patched,
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
