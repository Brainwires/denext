// The server copies carry the app's stylesheet imports, so `denext start` needs no CSS import map
// (and so no CSS re-exec, which a least-privilege start cannot spawn): `buildServerCopies` points
// each stylesheet import at its shim, and `buildServesCss` decides from `manifest.json` whether
// the CLI may skip the re-exec. tests/integration/scaffold-start.test.ts runs the whole path.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  buildServerCopies,
  buildServesCss,
  parseServerCopies,
  precompiledServerLoader,
} from "../src/build/server-copies.ts";
import { resolveProject } from "../src/build/paths.ts";
import { removeTempDir } from "./helpers/temp.ts";

/** A project with a layout importing `./globals.css` and a page importing nothing. */
async function project(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_server_css_" }));
  await Deno.mkdir(join(dir, "app"));
  await Deno.mkdir(join(dir, ".denext", "css-shims"), { recursive: true });
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(join(dir, "app", "globals.css"), "body{color:red}");
  await Deno.writeTextFile(
    join(dir, "app", "layout.tsx"),
    `import "./globals.css";\nexport const LAYOUT = "layout";\n`,
  );
  await Deno.writeTextFile(join(dir, "app", "page.tsx"), `export const PAGE = "page";\n`);
  await Deno.writeTextFile(
    join(dir, ".denext", "css-shims", "css_0.js"),
    `globalThis.__cssShimLoaded = true;\nexport default {};\n`,
  );
  return dir;
}

/** The build's CSS import map for {@linkcode project}. */
function cssMap(dir: string): Record<string, string> {
  return {
    [toFileUrl(join(dir, "app", "globals.css")).href]: toFileUrl(
      join(dir, ".denext", "css-shims", "css_0.js"),
    ).href,
    // An alias spelling is the import map's business; the copies resolve aliases to file URLs.
    "@/app/globals.css": toFileUrl(join(dir, ".denext", "css-shims", "css_0.js")).href,
  };
}

/** Write `manifest.json` with `doc`. */
async function writeManifest(dir: string, doc: unknown): Promise<void> {
  await Deno.writeTextFile(join(dir, ".denext", "manifest.json"), JSON.stringify(doc));
}

Deno.test("buildServerCopies: a module importing a stylesheet loads as a copy importing its shim", async () => {
  const dir = await project();
  try {
    const paths = await resolveProject(dir);
    const recorded = await buildServerCopies(paths, false, cssMap(dir));
    assert(recorded);
    assertEquals(recorded.css, true);
    assertEquals(recorded.redirects, {}, "a stylesheet is never a server entry");
    assertEquals(Object.keys(recorded.copies), ["app/layout.tsx"], "only the importer is copied");
    const copy = await Deno.readTextFile(join(dir, ".denext", recorded.copies["app/layout.tsx"]));
    assert(copy.includes("css-shims/css_0.js"), copy);
    assert(!copy.includes("globals.css"), copy);
    // The prod loader loads the copy: no `.css` import reaches Deno.
    const load = precompiledServerLoader((p) => import(p), paths, recorded)!;
    const mod = await load(join(dir, "app", "layout.tsx")) as { LAYOUT: string };
    assertEquals(mod.LAYOUT, "layout");
    assertEquals((globalThis as { __cssShimLoaded?: boolean }).__cssShimLoaded, true);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("buildServerCopies: an app without stylesheets records css: false", async () => {
  const dir = await project();
  try {
    const recorded = await buildServerCopies(await resolveProject(dir), false, undefined);
    assertEquals(recorded, {
      root: toFileUrl(dir).href,
      redirects: {},
      copies: {},
      css: false,
    });
    assertEquals(await buildServerCopies(await resolveProject(dir), true, cssMap(dir)), null);
  } finally {
    await removeTempDir(dir);
  }
});

Deno.test("parseServerCopies keeps the css flag only when it is a boolean", () => {
  const base = { root: "file:///a", redirects: {}, copies: {} };
  assertEquals(parseServerCopies({ ...base, css: true })?.css, true);
  assertEquals(parseServerCopies({ ...base, css: false })?.css, false);
  assertEquals(parseServerCopies({ ...base, css: "yes" }), base);
  assertEquals(parseServerCopies(base), base);
});

Deno.test("buildServesCss: only a CSS-aware native build made for this project skips the re-exec", async () => {
  const dir = await project();
  const outDir = join(dir, ".denext");
  const copies = (extra: Record<string, unknown>) => ({
    root: toFileUrl(dir).href,
    redirects: {},
    copies: {},
    ...extra,
  });
  try {
    assertEquals(await buildServesCss(dir, outDir), false, "no build");
    await Deno.writeTextFile(join(outDir, "manifest.json"), "{not json");
    assertEquals(await buildServesCss(dir, outDir), false, "an unreadable manifest");
    await writeManifest(dir, null);
    assertEquals(await buildServesCss(dir, outDir), false, "not a manifest");
    await writeManifest(dir, { serverCopies: copies({ css: true }) });
    assertEquals(await buildServesCss(dir, outDir), true);
    await writeManifest(dir, { serverCopies: copies({ css: false }) });
    assertEquals(await buildServesCss(dir, outDir), true, "no stylesheet to redirect");
    await writeManifest(dir, { serverCopies: copies({}) });
    assertEquals(await buildServesCss(dir, outDir), false, "an older build");
    await writeManifest(dir, { nextCompat: true, serverCopies: copies({ css: true }) });
    assertEquals(await buildServesCss(dir, outDir), false, "a next-compat build");
    await writeManifest(dir, { serverCopies: { ...copies({ css: true }), root: "file:///moved" } });
    assertEquals(await buildServesCss(dir, outDir), false, "a project moved since its build");
  } finally {
    await removeTempDir(dir);
  }
});
