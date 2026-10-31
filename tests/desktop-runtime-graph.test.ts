// Importing the desktop runtime (`denext/desktop`, what a packaged app's `desktop.ts` runs) decodes
// no Brotli pack.
//
// On Linux the packaged app runs in a WebKitGTK window, and the web view loads the system's
// `libbrotlidec`. The runtime's `node:zlib` Brotli binds to that library's
// `BrotliDecoderDecompressStream` and never returns, so a `brotliDecompressSync` while the app's
// modules evaluate kept it from ever serving its first page (the Linux window test: "no report;
// the page started no check", one thread at 100% in `BrotliDecoder.writeSync` under
// `MainWorker::evaluate_module`). It got there through the config validator, which reads the
// React Native manifest, a Brotli pack that decoded when imported. Data packs now decode on first
// read (`lazyPack` / `packedObject`), and this test keeps any eager decode out of the graph.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl, join, relative, toFileUrl } from "@std/path";
import { lazyPack, packedObject } from "../src/build/packed-text.ts";
import { boundedDeno } from "../scripts/deno-doc.ts";
import { packText } from "../scripts/lib/pack-texts.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** The readers of src/build/packed-text.ts that decode nothing until a value is read. */
const LAZY_READERS = new Set(["lazyPack", "packedObject", "packedRecords", "PackLayout"]);

/** The names a module imports from src/build/packed-text.ts (empty when it imports none). */
function packedTextImports(source: string): string[] {
  const names: string[] = [];
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"[^"]*\/packed-text\.ts"/g;
  for (const m of source.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

Deno.test({
  name: "desktop runtime graph: no module imports an eager pack decoder (Linux WebKitGTK hang)",
}, async () => {
  const root = toFileUrl(join(REPO, "src/build/desktop.ts")).href;
  const out = await boundedDeno(["info", "--json", root], { cwd: REPO });
  assert(out.success, out.stderr);
  const graph = JSON.parse(out.stdout) as {
    modules: Array<{ specifier: string; dependencies?: Array<{ code?: { specifier?: string } }> }>;
  };
  // The CLI verbs' specs spread their packed description when imported (src/cli/command-meta.ts):
  // that reader is lazy, but a verb module the runtime imports would decode it at once.
  assertEquals(
    graph.modules.map((m) => m.specifier).filter((s) => s.endsWith("/src/cli/command-meta.ts")),
    [],
    "the desktop runtime imports a CLI verb, whose spec decodes the packed verb table",
  );
  const readers = graph.modules.filter((m) =>
    m.dependencies?.some((d) => d.code?.specifier?.endsWith("/src/build/packed-text.ts"))
  );
  const eager: string[] = [];
  for (const m of readers) {
    const source = await Deno.readTextFile(fromFileUrl(m.specifier));
    const names = packedTextImports(source).filter((n) => !LAZY_READERS.has(n));
    if (names.length > 0) {
      eager.push(`${relative(REPO, fromFileUrl(m.specifier))}: ${names.join(", ")}`);
    }
  }
  assertEquals(
    eager,
    [],
    "a module the desktop runtime imports reads a pack with an eager decoder; on Linux the " +
      "app hangs before its first page: read it lazily (lazyPack / packedObject)",
  );
});

Deno.test("lazyPack: nothing is decoded until the first call, then once", () => {
  // Not a pack at all: creating the reader must not touch it.
  const broken = lazyPack("not base64 brotli");
  assertThrows(() => broken());
  const pack = lazyPack(packText(JSON.stringify({ X: { a: 1 } })));
  assertEquals(pack(), { X: { a: 1 } });
  assertEquals(pack(), pack());
  assert(pack() === pack(), "decoded once and kept");
});

Deno.test("packedObject: keys without a decode; the first value read decodes the pack", () => {
  let decodes = 0;
  const pack = () => {
    decodes++;
    return { TABLE: { a: { n: 1 }, b: { n: 2 } } };
  };
  const table = packedObject<Record<string, { n: number }>>(pack, "TABLE", ["a", "b"]);
  assertEquals(Object.keys(table), ["a", "b"]);
  assert("a" in table && Object.hasOwn(table, "b"));
  assertEquals(decodes, 0, "listing the keys decodes nothing");
  assertEquals(table.a.n, 1);
  assert(decodes >= 1, "a read decodes");
  assertEquals(JSON.parse(JSON.stringify(table)), { a: { n: 1 }, b: { n: 2 } });
});

Deno.test("the React Native and expo manifests decode nothing when imported", async () => {
  for (
    const path of [
      "../src/react-native-compat/manifest-data.packed.ts",
      "../src/expo/manifest-data.packed.ts",
    ]
  ) {
    const source = await Deno.readTextFile(fromFileUrl(new URL(path, import.meta.url)));
    assertEquals(packedTextImports(source).filter((n) => !LAZY_READERS.has(n)), [], path);
  }
});
