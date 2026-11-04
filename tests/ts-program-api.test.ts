// src/ts/program-api.ts, denext's one seam to TypeScript's program API: TypeScript 7.1's stable
// subpaths (not 7.0's `unstable/`), every pin naming the one `TYPESCRIPT_API_VERSION` the parity
// installs use too, and `openConfiguredProject` opening a tsconfig in a snapshot.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { openConfiguredProject, ts, TYPESCRIPT_API_VERSION } from "../src/ts/program-api.ts";

const read = (path: string) => Deno.readTextFileSync(new URL(path, import.meta.url));

Deno.test("program API: one pinned 7.1 version, on the stable subpaths", () => {
  assertMatch(TYPESCRIPT_API_VERSION, /^7\.1\.\d+(-[\w.]+)?$/);
  const source = read("../src/ts/program-api.ts");
  const pins = [...source.matchAll(/npm:typescript@([^/"]+)(\/[^"]*)?"/g)];
  assert(pins.length >= 3, "the type import, the API and the AST");
  for (const [spec, version, subpath] of pins) {
    assertEquals(version, TYPESCRIPT_API_VERSION, spec);
    assert(!subpath?.startsWith("/unstable/"), `${spec}: 7.1's stable subpath`);
  }
});

Deno.test("program API: the parity installs depend on the pinned version, not a literal", () => {
  for (const path of ["../scripts/parity/refresh.ts", "../scripts/parity/native/capture.ts"]) {
    const source = read(path);
    assert(source.includes("TYPESCRIPT_API_VERSION"), path);
    assert(!/typescript["']?\s*[:=]\s*["'][~^]?\d/.test(source), `${path}: no literal version`);
  }
});

Deno.test("openConfiguredProject: a tsconfig's program and checker", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ts_program_api_" });
  const api = new ts.API({ cwd: dir });
  try {
    const file = join(dir, "mod.ts");
    await Deno.writeTextFile(file, "export const answer: number = 42;\n");
    const config = join(dir, "tsconfig.json");
    await Deno.writeTextFile(
      config,
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: [file] }),
    );
    const { program, checker } = await openConfiguredProject(api, config);
    const sourceFile = await program.getSourceFile(file);
    assert(sourceFile, "the file is in the program");
    const module = await checker.getSymbolAtLocation(sourceFile as never);
    assert(module, "the module has a symbol");
    const exports = await checker.getExportsOfModule(module);
    assertEquals(exports.map((s) => s.name), ["answer"]);
    assert((exports[0].flags & ts.SymbolFlags.Value) !== 0, "a value export");
  } finally {
    await api.close();
    // The client closes its native compiler child without waiting for it to exit (no handle
    // reaches here); give it the moment before removing its cwd (Windows saw it still running).
    await new Promise((r) => setTimeout(r, 2_000));
    await Deno.remove(dir, { recursive: true });
  }
});
