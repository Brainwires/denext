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
