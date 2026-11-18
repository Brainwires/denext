// `output: "export"` parity: `denext export` writes the files `next build` with
// `output: "export"` writes for the same App Router source (tests/fixtures/export-parity/app.ts).
// Next's file list per variant is a snapshot (tests/fixtures/export-parity/next-<variant>.json),
// regenerated with the pinned Next.js by
//
//   deno run -A scripts/export-parity-snapshot.ts
//
// so this check needs no Node or Next. A page or a static file Next writes and denext doesn't (a
// route handler's output, a metadata file, `404.html`) fails it; so does one denext writes and
// Next doesn't. The differences that are deliberate are listed in DELIBERATE with the reason.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { exportInChild } from "../helpers/bounded-build.ts";
import {
  comparableFiles,
  listFiles,
  NEXT_VERSION,
  type ParityVariant,
  VARIANTS,
  writeParityApp,
} from "../fixtures/export-parity/app.ts";

const FIXTURE_DIR = fromFileUrl(new URL("../fixtures/export-parity/", import.meta.url));

/**
 * Files Next writes that denext deliberately does not, each with why:
 * - the RSC payloads beside every page (`index.txt`, `about.txt`, `about/index.txt`) and the
 *   per-segment prefetch files (`__next.*.txt`): Next's client router reads them on a soft
 *   navigation; denext's reads the page's HTML (or its compact iso payload from a server), so
 *   it has no RSC wire format to write;
 * - `_not-found.html` / `_not-found/index.html` (+ its payloads): Next's internal not-found
 *   route, written beside the `404.html` copy of it, which denext writes.
 */
function deliberatelyOmitted(file: string): boolean {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (name.startsWith("__next.")) return true;
  if (file === "_not-found.html" || file.startsWith("_not-found")) return true;
  return name.endsWith(".txt") && file !== "robots.txt";
}

/**
 * The URL a file serves, so layouts compare: Next writes a page as `about.html` without
 * `trailingSlash` where denext writes `about/index.html` (deliberate: denext keeps one layout,
 * which every static host serves at `/about` — the desktop, Capacitor and SPA servers resolve
 * both); with `trailingSlash` both write `about/index.html`.
 */
function servedAs(file: string): string {
  if (file === "404.html" || file === "404/index.html") return file;
  if (file === "index.html") return "/";
  if (file.endsWith("/index.html")) return `/${file.slice(0, -"/index.html".length)}`;
  if (file.endsWith(".html")) return `/${file.slice(0, -".html".length)}`;
  return file;
}

async function nextFiles(variant: ParityVariant): Promise<string[]> {
  const snap = JSON.parse(
    await Deno.readTextFile(join(FIXTURE_DIR, `next-${variant.name}.json`)),
  ) as { next: string; files: string[] };
  // A pin moved without a regenerated snapshot would compare against another Next.
  assertEquals(
    snap.next,
    NEXT_VERSION,
    "regenerate: deno run -A scripts/export-parity-snapshot.ts",
  );
  return snap.files;
}

for (const variant of VARIANTS) {
  Deno.test({
    name: `export parity with next build (output: "export"): ${variant.name}`,
  }, async () => {
    const dir = await Deno.makeTempDir({ prefix: `denext_export_parity_${variant.name}_` });
    try {
      await writeParityApp(dir, variant, "denext");
      const result = await exportInChild(dir);
      const ours = comparableFiles(await listFiles(result.outDir)).map(servedAs).sort();
      const theirs = (await nextFiles(variant)).filter((f) => !deliberatelyOmitted(f))
        .map(servedAs).sort();
      assertEquals(ours, theirs);
      assertEquals(result.skipped, [], "nothing in the fixture is skipped");
    } finally {
      await stopNextCompat();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}
