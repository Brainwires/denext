// A bundled Node backend's runtime packages (src/desktop/sidecar-modules.ts): archived at
// packaging (never embedded as a node_modules tree, which `deno desktop` under
// `--node-modules-dir=none` refuses for CommonJS re-exports), unpacked into the cache folder once
// per version, and resolved from there both by the bundle's `require` and by the backend's own
// `createRequire(import.meta.url)` — through the host's real launcher.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  packSidecarModules,
  prepareSidecarModules,
  SIDECAR_MODULES_INFO,
  SIDECAR_MODULES_PACK,
} from "../src/desktop/sidecar-modules.ts";
import { bundleDesktopSidecar } from "../src/build/desktop-sidecar-bundle.ts";
import { createSidecarHost } from "../src/desktop/sidecar-host.ts";
import type { SidecarDefinition } from "../src/desktop/sidecar.ts";

/** Write `files` (path → text) under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

Deno.test("packSidecarModules / prepareSidecarModules: a round trip, kept while current, replaced on a new version", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-pack-" });
  try {
    await writeTree(root, {
      "stage/node_modules/a/package.json": '{"name":"a"}',
      "stage/node_modules/a/bin/run": "#!/bin/sh\n",
      "stage/node_modules/@s/b/index.js": "module.exports = 1;\n",
    });
    if (Deno.build.os !== "windows") {
      await Deno.chmod(join(root, "stage/node_modules/a/bin/run"), 0o755);
    }
    await Deno.mkdir(join(root, "bundle"));
    const info = await packSidecarModules(join(root, "stage"), join(root, "bundle"));
    assertEquals(info.files, 3);
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(root, "bundle", SIDECAR_MODULES_INFO))),
      info,
    );
    const cache = join(root, "cache");
    const first = await prepareSidecarModules(join(root, "bundle"), "api", cache);
    assertEquals(first, join(cache, "sidecars", "api", `modules-${info.hash.slice(0, 16)}`));
    assertEquals(
      await Deno.readTextFile(join(first!, "node_modules/@s/b/index.js")),
      "module.exports = 1;\n",
    );
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(join(first!, "node_modules/a/bin/run"))).mode! & 0o111, 0o111);
    }
    // Current: nothing is written again.
    await Deno.writeTextFile(join(first!, "node_modules/a/package.json"), "touched");
    assertEquals(await prepareSidecarModules(join(root, "bundle"), "api", cache), first);
    assertEquals(await Deno.readTextFile(join(first!, "node_modules/a/package.json")), "touched");
    // A new version replaces the old one.
    await Deno.writeTextFile(join(root, "stage/node_modules/a/package.json"), '{"name":"a","v":2}');
    await packSidecarModules(join(root, "stage"), join(root, "bundle"));
    const second = await prepareSidecarModules(join(root, "bundle"), "api", cache);
    assert(second !== first);
    assertEquals(await Deno.stat(first!).then(() => true, () => false), false);
    // Two launches unpacking the same version at once both get it.
    const cache2 = join(root, "cache2");
    const [x, y] = await Promise.all([
      prepareSidecarModules(join(root, "bundle"), "api", cache2),
      prepareSidecarModules(join(root, "bundle"), "api", cache2),
    ]);
    assertEquals(x, y);
    // No archive: nothing to unpack.
    assertEquals(await prepareSidecarModules(join(root, "stage"), "api", cache), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("prepareSidecarModules: a corrupt or escaping archive is refused and leaves nothing behind", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-badpack-" });
  try {
    const bundle = join(root, "bundle");
    await Deno.mkdir(bundle);
    const info = (hash: string) =>
      Deno.writeTextFile(
        join(bundle, SIDECAR_MODULES_INFO),
        JSON.stringify({ hash, files: 1, bytes: 1 }),
      );
    await info("a".repeat(64));
    await Deno.writeFile(
      join(bundle, SIDECAR_MODULES_PACK),
      new TextEncoder().encode("not a pack"),
    );
    await assertRejects(
      () => prepareSidecarModules(bundle, "api", join(root, "cache")),
      Error,
      "not a sidecar",
    );
    // A header naming a path outside the root.
    const header = new TextEncoder().encode(JSON.stringify({ files: [{ p: "../evil", s: 1 }] }));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, header.length);
    const pack = new Uint8Array([
      ...new TextEncoder().encode("DNXSCPK1\n"),
      ...len,
      ...header,
      0x41,
    ]);
    await Deno.writeFile(join(bundle, SIDECAR_MODULES_PACK), pack);
    await info("b".repeat(64));
    await assertRejects(
      () => prepareSidecarModules(bundle, "api", join(root, "cache")),
      Error,
      "malformed",
    );
    assertEquals(await Deno.stat(join(root, "evil")).then(() => true, () => false), false);
    const left = [...Deno.readDirSync(join(root, "cache", "sidecars", "api"))];
    assertEquals(left.filter((e) => e.name.endsWith(".tmp")), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("host: a bundled backend unpacks its packages on its first start; its own createRequire finds them", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-hostpack-" });
  try {
    await writeTree(root, {
      "srv/main.mjs": `import { createRequire } from "node:module";
import native from "native-cjs";
const own = createRequire(import.meta.url)("native-cjs");
console.log(JSON.stringify({ viaImport: native.inner, viaOwnRequire: own.inner }));
globalThis.denextSidecar.ready();
`,
      "srv/node_modules/native-cjs/package.json":
        '{"name":"native-cjs","main":"i.js","gypfile":true,"dependencies":{"inner":"1"}}',
      "srv/node_modules/native-cjs/i.js":
        '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.inner = require("inner").v;\n',
      "srv/node_modules/inner/package.json": '{"name":"inner","main":"i.js"}',
      "srv/node_modules/inner/i.js": 'exports.v = "inner";\n',
    });
    const def: SidecarDefinition = {
      name: "api",
      run: { module: "srv/main.mjs", nodeModules: "srv/node_modules" },
      ready: { signal: true },
      logs: "none",
    };
    await bundleDesktopSidecar({ projectDir: root, definition: def, ffiGranted: true });
    await Deno.remove(join(root, "srv"), { recursive: true });
    const lines: string[] = [];
    // Without a cache folder the host unpacks into a fresh temp dir: note the ones that exist, to
    // remove what this test made.
    const tmp = join(root, "..");
    const before = new Set([...Deno.readDirSync(tmp)].map((e) => e.name));
    for (const cacheDir of [join(root, "cache"), undefined]) {
      const host = await createSidecarHost({
        sidecars: [{ ...def, logs: "inherit" }],
        importMetaUrl: toFileUrl(join(root, "desktop.ts")).href,
        ...(cacheDir ? { cacheDir } : {}),
      });
      const orig = console.error;
      console.error = (...a: unknown[]) => lines.push(a.join(" "));
      try {
        host.startAll();
        assertEquals((await host.handle("api").whenReady(15_000)).state, "ready");
      } finally {
        console.error = orig;
        await host.stopAll();
      }
    }
    for (const e of Deno.readDirSync(tmp)) {
      // The host's fallback cache (its own prefix), holding this test's sidecar.
      const ours = e.name.startsWith("denext-sidecar-cache-") &&
        await Deno.stat(join(tmp, e.name, "sidecars", "api")).then(() => true, () => false);
      if (!before.has(e.name) && ours) {
        await Deno.remove(join(tmp, e.name), { recursive: true });
      }
    }
    const out = lines.filter((l) => l.includes("viaImport"));
    assertEquals(out.length, 2);
    assert(out[0].includes('{"viaImport":"inner","viaOwnRequire":"inner"}'), out[0]);
    assert(await Deno.stat(join(root, "cache", "sidecars", "api")).then((s) => s.isDirectory));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("host: a bundle whose archive cannot be unpacked fails its start, and is retried", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-sidecar-hostbad-" });
  try {
    const bundle = join(root, ".deno-desktop", "sidecars", "api");
    await writeTree(bundle, { "main.mjs": "globalThis.denextSidecar.ready();\n" });
    await Deno.writeTextFile(
      join(bundle, SIDECAR_MODULES_INFO),
      JSON.stringify({ hash: "c".repeat(64) }),
    );
    await Deno.writeTextFile(join(bundle, SIDECAR_MODULES_PACK), "garbage");
    const host = await createSidecarHost({
      sidecars: [{
        name: "api",
        run: { module: "x.mjs", nodeModules: "nm" },
        restart: { maxAttempts: 1, backoffMs: 1 },
        logs: "none",
      }],
      importMetaUrl: toFileUrl(join(root, "desktop.ts")).href,
      cacheDir: join(root, "cache"),
    });
    const orig = console.error;
    console.error = () => {};
    try {
      host.startAll();
      const status = await host.handle("api").whenReady(10_000);
      assertEquals(status.state, "failed");
      assertEquals(status.attempts, 2, "the unpack was tried again on the retry");
      assert(String(status.lastExit?.error).includes("not a sidecar modules archive"));
    } finally {
      console.error = orig;
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
