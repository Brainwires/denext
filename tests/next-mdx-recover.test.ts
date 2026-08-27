import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { resolveNextMdx } from "../src/build/next-mdx-recover.ts";

// resolveNextMdx runs the app's own next.config with `@next/mdx` swapped for denext's
// capturing shim, so the LIVE plugin functions are recovered — no serialization, no deps.

Deno.test("resolveNextMdx recovers live remark plugins + providerImportSource from next.config", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_mdxrec_" });
  try {
    // Plugins are inline fns (no external package needed) — the point is that real
    // function references survive into the returned options.
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      `import createMDX from "@next/mdx";\n` +
        `const remarkA = () => (tree) => tree;\n` +
        `const remarkB = () => (tree) => tree;\n` +
        `const withMDX = createMDX({ options: {\n` +
        `  remarkPlugins: [remarkA, [remarkB, { opt: 1 }]],\n` +
        `  providerImportSource: "@mdx-js/react",\n` +
        `} });\n` +
        `export default withMDX({ pageExtensions: ["ts", "tsx", "md", "mdx"] });\n`,
    );
    // baseUrl is any file URL in the dir; relPath points at the config beside it.
    const baseUrl = toFileUrl(join(dir, "denext.config.ts")).href;
    const mdx = await resolveNextMdx(baseUrl, "./next.config.mjs");

    assert(mdx, "expected recovered MDX options");
    assertEquals(mdx!.remarkPlugins!.length, 2, "both remark plugins captured");
    // The bare fn and the [fn, opts] tuple are both preserved as live references.
    assertEquals(typeof mdx!.remarkPlugins![0], "function");
    assert(Array.isArray(mdx!.remarkPlugins![1]));
    assertEquals(mdx!.providerImportSource, "@mdx-js/react");
    // No probe artifact is left behind in the app dir.
    const leftover = [...Deno.readDirSync(dir)].some((e) => e.name.includes("denext-mdx-probe"));
    assert(!leftover, "probe temp file cleaned up");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveNextMdx returns undefined when next.config wires no MDX", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_mdxrec_none_" });
  try {
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      `export default { reactStrictMode: true };\n`,
    );
    const baseUrl = toFileUrl(join(dir, "denext.config.ts")).href;
    assertEquals(await resolveNextMdx(baseUrl, "./next.config.mjs"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveNextMdx returns undefined (warns, no throw) when next.config can't run", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_mdxrec_bad_" });
  try {
    // Looks MDX-y (so it probes) but throws on import — recovery must degrade, not crash.
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      `import createMDX from "@next/mdx";\n` +
        `throw new Error("boom");\n` +
        `export default createMDX({ options: { remarkPlugins: [] } })({});\n`,
    );
    const baseUrl = toFileUrl(join(dir, "denext.config.ts")).href;
    assertEquals(await resolveNextMdx(baseUrl, "./next.config.mjs"), undefined);
    const leftover = [...Deno.readDirSync(dir)].some((e) => e.name.includes("denext-mdx-probe"));
    assert(!leftover, "probe temp file cleaned up even on failure");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveNextMdx returns undefined for a missing next.config", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_mdxrec_missing_" });
  try {
    const baseUrl = toFileUrl(join(dir, "denext.config.ts")).href;
    assertEquals(await resolveNextMdx(baseUrl, "./next.config.mjs"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
