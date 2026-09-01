// Project-path resolution, including the optional `src/` directory layout.

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveProject, validateDenextConfig } from "../src/build/paths.ts";

async function scaffold(
  layout: "root" | "src",
  extras: string[] = [],
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_paths_" });
  const base = layout === "src" ? join(dir, "src") : dir;
  await Deno.mkdir(join(base, "app"), { recursive: true });
  await Deno.writeTextFile(join(base, "app", "page.tsx"), "export default () => null;\n");
  for (const rel of extras) {
    await Deno.mkdir(join(base, rel, ".."), { recursive: true }).catch(() => {});
    await Deno.writeTextFile(join(base, rel), "export default () => {};\n");
  }
  return dir;
}

Deno.test("validateDenextConfig rejects malformed fields with a field-scoped error (BLD-M4)", () => {
  // A valid config passes.
  validateDenextConfig({
    basePath: "/docs",
    trailingSlash: true,
    images: { domains: ["cdn.example.com"], remotePatterns: [{ hostname: "*.example.com" }] },
    redirects: () => [],
  });
  // An empty basePath (the "no sub-path" form) is allowed.
  validateDenextConfig({ basePath: "" });

  const bad: Array<[Record<string, unknown>, string]> = [
    [{ basePath: "docs" }, "basePath"], // missing leading slash
    [{ basePath: "/docs/" }, "basePath"], // trailing slash
    [{ trailingSlash: "yes" }, "trailingSlash"],
    [{ assetPrefix: 5 }, "assetPrefix"],
    [{ redirects: [] }, "redirects"], // must be a function, not an array
    [{ images: { domains: [1, 2] } }, "images.domains"],
    [{ images: { remotePatterns: [{}] } }, "images.remotePatterns"],
  ];
  for (const [cfg, field] of bad) {
    assertThrows(() => validateDenextConfig(cfg, "denext.config.ts"), Error, field);
  }
});

Deno.test("validateDenextConfig rejects non-finite / out-of-range numerics at boot", () => {
  // Valid numerics pass.
  validateDenextConfig({
    hsts: { maxAge: 31536000 },
    images: {
      deviceSizes: [640, 1080],
      imageSizes: [16, 32],
      qualities: [75, 90],
      minimumCacheTTL: 14400,
      maximumRedirects: 0, // 0 = disable redirects; must be allowed
    },
    cache: { maxDataEntries: 1000, maxPageEntries: 500 },
  });

  // A `NaN`/`Infinity`/negative/out-of-range value would otherwise flow into a header,
  // a redirect-loop bound, or an eviction count — each must throw naming the field.
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ hsts: { maxAge: Number.NaN } }, "hsts.maxAge"],
    [{ hsts: { maxAge: -1 } }, "hsts.maxAge"],
    [{ images: { maximumRedirects: Number.POSITIVE_INFINITY } }, "images.maximumRedirects"],
    [{ images: { maximumRedirects: 1.5 } }, "images.maximumRedirects"], // non-integer
    [{ images: { qualities: [0, 200] } }, "images.qualities"], // outside 1..100
    [{ images: { deviceSizes: [640, Number.NaN] } }, "images.deviceSizes[1]"],
    [{ images: { imageSizes: "16,32" } }, "images.imageSizes"], // not an array
    [{ cache: { maxDataEntries: -1 } }, "cache.maxDataEntries"],
    [{ cache: { maxPageEntries: 0 } }, "cache.maxPageEntries"], // counts must be >= 1
  ];
  for (const [cfg, field] of bad) {
    assertThrows(() => validateDenextConfig(cfg, "denext.config.ts"), Error, field);
  }
});

Deno.test("resolveProject uses top-level app/ by default", async () => {
  const dir = await scaffold("root");
  try {
    const paths = await resolveProject(dir);
    assertEquals(paths.appDir, join(dir, "app"));
    assertEquals(paths.publicDir, join(dir, "public"));
    assertEquals(paths.outDir, join(dir, ".denext"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveProject uses src/app when present (public/config stay at root)", async () => {
  const dir = await scaffold("src", ["middleware.ts", "instrumentation.ts"]);
  try {
    const paths = await resolveProject(dir);
    assertEquals(paths.appDir, join(dir, "src", "app"));
    assertEquals(paths.middlewarePath, join(dir, "src", "middleware.ts"));
    assertEquals(paths.instrumentationPath, join(dir, "src", "instrumentation.ts"));
    // public/ and the build output stay at the project root (Next.js semantics).
    assertEquals(paths.publicDir, join(dir, "public"));
    assertEquals(paths.outDir, join(dir, ".denext"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
