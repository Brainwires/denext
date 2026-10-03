// The relocatable import map a `deno desktop` package build uses (src/build/desktop-import-map.ts):
// a compiled binary resolves an ABSOLUTE local import-map target to the build machine's path, so
// packaging rewrites such a map with every local target relative to the written copy, and
// `desktopIncludeArgs` hands the copy to `deno desktop` as `--import-map`.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  DESKTOP_IMPORT_MAP_FILE,
  desktopImportMapArgsFor,
  relocatableImportMap,
} from "../src/build/desktop-import-map.ts";
import { desktopIncludeArgs } from "../src/build/desktop-capabilities.ts";

const BASE = new URL("file:///work/app/deno.json");
const OUT = "/work/app/.deno-desktop";

Deno.test("relocatableImportMap: a map with only relative / remote / bare targets needs nothing", () => {
  assertEquals(
    relocatableImportMap(
      {
        imports: {
          "denext": "../../mod.ts",
          "denext/server": "./vendor/denext/server.ts",
          "@std/path": "jsr:@std/path@^1",
          "zod": "npm:zod@^4",
          "remote": "https://example.com/mod.ts",
          "node:fs": "node:fs",
        },
        scopes: { "./vendor/": { "x": "./x.ts" } },
      },
      BASE,
      OUT,
    ),
    null,
  );
  assertEquals(relocatableImportMap({}, BASE, OUT), null);
  assertEquals(relocatableImportMap(undefined, BASE, OUT), null);
  assertEquals(relocatableImportMap({ imports: [] }, BASE, OUT), null);
});

Deno.test("relocatableImportMap: absolute file: and path-absolute targets become relative to the copy", () => {
  if (Deno.build.os === "windows") return; // POSIX paths below
  const map = relocatableImportMap(
    {
      imports: {
        "denext/desktop": "file:///work/denext-wt/src/build/desktop.ts",
        "denext/": "/work/denext-wt/src/",
        "local": "./lib/local.ts",
        "up": "../shared/up.ts",
        "@std/path": "jsr:@std/path@^1",
        "skip": 42,
      },
    },
    BASE,
    OUT,
  );
  assertEquals(map, {
    imports: {
      "denext/desktop": "../../denext-wt/src/build/desktop.ts",
      "denext/": "../../denext-wt/src/",
      "local": "../lib/local.ts",
      "up": "../../shared/up.ts",
      "@std/path": "jsr:@std/path@^1",
    },
  });
});

Deno.test("relocatableImportMap: an absolute scope key or scoped target triggers it, and is relocated", () => {
  if (Deno.build.os === "windows") return;
  assertEquals(
    relocatableImportMap(
      {
        imports: { "a": "./a.ts" },
        scopes: {
          "file:///work/denext-wt/": { "@std/path": "jsr:@std/path@^1" },
          "./vendor/": { "b": "file:///work/b/b.ts", "c": "./c.ts" },
        },
      },
      BASE,
      OUT,
    ),
    {
      imports: { "a": "../a.ts" },
      scopes: {
        "../../denext-wt/": { "@std/path": "jsr:@std/path@^1" },
        "../vendor/": { "b": "../../b/b.ts", "c": "../c.ts" },
      },
    },
  );
  // A target inside the copy's own folder keeps a `./` prefix.
  assertEquals(
    relocatableImportMap(
      { imports: { "here": "file:///work/app/.deno-desktop/here.ts" } },
      BASE,
      OUT,
    ),
    { imports: { "here": "./here.ts" } },
  );
});

Deno.test("relocatableImportMap: a deno.json map's jsr:/npm: entries get Deno's subpath entries", () => {
  if (Deno.build.os === "windows") return;
  const map = {
    imports: {
      "abs": "file:///work/abs.ts",
      "@std/http": "jsr:@std/http@^1",
      "@std/fs": "jsr:@std/fs@^1",
      "@std/fs/": "jsr:/@std/fs@^1.0.1/",
      "zod": "npm:zod@^4",
      "dir/": "jsr:/@x/dir@1/",
    },
  };
  assertEquals(relocatableImportMap(map, BASE, OUT, true)?.imports, {
    "abs": "../../abs.ts",
    "@std/http": "jsr:@std/http@^1",
    "@std/http/": "jsr:/@std/http@^1/",
    "@std/fs": "jsr:@std/fs@^1",
    "@std/fs/": "jsr:/@std/fs@^1.0.1/", // an explicit subpath entry wins
    "zod": "npm:zod@^4",
    "zod/": "npm:/zod@^4/",
    "dir/": "jsr:/@x/dir@1/",
  });
  // An import map FILE gets no derived entries (Deno derives them for deno.json only).
  assertEquals(Object.hasOwn(relocatableImportMap(map, BASE, OUT)!.imports!, "@std/http/"), false);
});

/** A temp project with a deno.json (and optionally more files), plus its `scripts/` folder. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-import-map-" }));
  await Deno.mkdir(join(dir, "scripts"));
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
  return dir;
}

Deno.test("desktopImportMapArgsFor: writes the relocatable copy only when it is needed", async () => {
  const lib = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-import-map-lib-" }));
  const absolute = await project({
    "deno.json": JSON.stringify({
      imports: { "dep": toFileUrl(join(lib, "dep.ts")).href, "@std/path": "jsr:@std/path@^1" },
    }),
  });
  const relative = await project({ "deno.json": JSON.stringify({ imports: { "dep": "./d.ts" } }) });
  const none = await project({});
  try {
    const file = join(absolute, ...DESKTOP_IMPORT_MAP_FILE.split("/"));
    assertEquals(await desktopImportMapArgsFor(absolute), ["--import-map", file]);
    const written = JSON.parse(await Deno.readTextFile(file));
    assertEquals(written.imports["@std/path"], "jsr:@std/path@^1");
    assertEquals(written.imports["@std/path/"], "jsr:/@std/path@^1/");
    assert(!written.imports.dep.startsWith("file:"), written.imports.dep);
    // The relative target resolves (from the copy's folder) back to the same file.
    assertEquals(
      new URL(written.imports.dep, toFileUrl(file)).href,
      toFileUrl(join(lib, "dep.ts")).href,
    );

    // No absolute target → no flag, and a stale copy from an earlier build is removed.
    const stale = join(relative, ...DESKTOP_IMPORT_MAP_FILE.split("/"));
    await Deno.mkdir(join(relative, ".deno-desktop"));
    await Deno.writeTextFile(stale, "{}");
    assertEquals(await desktopImportMapArgsFor(relative), []);
    await assertRejects(() => Deno.stat(stale));
    assertEquals(await desktopImportMapArgsFor(none), []);
  } finally {
    for (const d of [lib, absolute, relative, none]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("desktopImportMapArgsFor: reads deno.jsonc and an importMap file next to it", async () => {
  if (Deno.build.os === "windows") return;
  const viaFile = await project({
    "deno.jsonc": '// comment\n{ "importMap": "./maps/import_map.json" }',
    "maps/import_map.json": JSON.stringify({ imports: { "x": "/opt/x/mod.ts", "y": "./y.ts" } }),
  });
  const remote = await project({
    "deno.json": JSON.stringify({ importMap: "https://example.com/import_map.json" }),
  });
  try {
    const args = await desktopImportMapArgsFor(viaFile);
    assertEquals(args.length, 2);
    const written = JSON.parse(await Deno.readTextFile(args[1]));
    // `./y.ts` was relative to the map FILE (maps/), not to deno.jsonc.
    assertEquals(written.imports.y, "../maps/y.ts");
    assertEquals(Object.keys(written.imports).sort(), ["x", "y"]);
    assertEquals(new URL(written.imports.x, toFileUrl(args[1])).href, "file:///opt/x/mod.ts");
    assertEquals(await desktopImportMapArgsFor(remote), []);
  } finally {
    await Deno.remove(viaFile, { recursive: true });
    await Deno.remove(remote, { recursive: true });
  }
});

Deno.test("desktopImportMapArgsFor: refuses to write through a symlinked .deno-desktop", async () => {
  if (Deno.build.os === "windows") return; // symlinks need privileges there
  const elsewhere = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-import-map-x-" }));
  const dir = await project({
    "deno.json": JSON.stringify({ imports: { "x": "file:///opt/x.ts" } }),
  });
  try {
    await Deno.symlink(elsewhere, join(dir, ".deno-desktop"));
    await assertRejects(() => desktopImportMapArgsFor(dir), Error, "symlink");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("desktopIncludeArgs: the extension --includes, then --import-map for an absolute import map", async () => {
  const dir = await project({
    "denext.config.ts":
      'export default { desktop: { capabilities: { extensions: ["./desktop/ext.ts"] } } };\n',
  });
  try {
    // denext mapped by absolute `file:` URL, as a checkout outside the project is.
    const desktop = toFileUrl(join(dir, "..", "denext", "src", "build", "desktop.ts")).href;
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "denext/desktop": desktop } }),
    );
    const script = toFileUrl(join(dir, "scripts", "package-macos.ts")).href;
    assertEquals(await desktopIncludeArgs(script), [
      "--include",
      "./desktop/ext.ts",
      "--import-map",
      join(dir, ...DESKTOP_IMPORT_MAP_FILE.split("/")),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
