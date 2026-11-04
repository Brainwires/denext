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

Deno.test("resolveNextMdx resolves STRING plugin specifiers to functions (webpack/@next-mdx form)", async () => {
  // @next/mdx accepts a plugin as a string specifier (resolved from node_modules); MDX's
  // compile needs the function. resolveNextMdx must import the string in app context and
  // hand back the fn. A relative-path specifier stands in for a node_modules package here.
  const dir = await Deno.makeTempDir({ prefix: "denext_mdxrec_str_" });
  try {
    await Deno.writeTextFile(
      join(dir, "my-remark.mjs"),
      `export default function myRemark(opts) { return (tree) => tree; }\n`,
    );
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      `import createMDX from "@next/mdx";\n` +
        `const withMDX = createMDX({ options: {\n` +
        `  remarkPlugins: [["./my-remark.mjs", { k: 1 }]],\n` +
        `} });\n` +
        `export default withMDX({});\n`,
    );
    const baseUrl = toFileUrl(join(dir, "denext.config.ts")).href;
    const mdx = await resolveNextMdx(baseUrl, "./next.config.mjs");
    assert(mdx?.remarkPlugins, "remark plugins recovered");
    const entry = mdx!.remarkPlugins![0];
    assert(Array.isArray(entry), "kept the [plugin, options] tuple shape");
    assertEquals(typeof entry[0], "function", "string specifier resolved to a function");
    assertEquals(entry[1], { k: 1 }, "options preserved");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveNextMdx drops an unresolvable string plugin (warns, keeps the rest)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_mdxrec_drop_" });
  try {
    await Deno.writeTextFile(
      join(dir, "ok.mjs"),
      `export default () => (tree) => tree;\n`,
    );
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      `import createMDX from "@next/mdx";\n` +
        `export default createMDX({ options: {\n` +
        `  remarkPlugins: ["./ok.mjs", "./does-not-exist.mjs"],\n` +
        `} })({});\n`,
    );
    const baseUrl = toFileUrl(join(dir, "denext.config.ts")).href;
    const mdx = await resolveNextMdx(baseUrl, "./next.config.mjs");
    // The resolvable plugin survives; the missing one is dropped rather than crashing.
    assertEquals(mdx?.remarkPlugins?.length, 1);
    assertEquals(typeof mdx!.remarkPlugins![0], "function");
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

/**
 * Run resolveNextMdx in a child with read access but no write access beside the config (a
 * least-privilege `denext start`: `--allow-write=.denext`); its result and stderr.
 */
async function recoverWithoutWrite(
  dir: string,
  env: Record<string, string> = {},
): Promise<{ result: string; stderr: string }> {
  const mod = new URL("../src/build/next-mdx-recover.ts", import.meta.url).href;
  const baseUrl = toFileUrl(join(dir, "denext.config.ts")).href;
  // `deno eval` would grant everything: run a script file under `deno run` instead.
  const script = join(dir, ".denext", "probe-run.ts");
  await Deno.mkdir(join(dir, ".denext"), { recursive: true });
  await Deno.writeTextFile(
    script,
    `const { resolveNextMdx } = await import(${JSON.stringify(mod)});\n` +
      `const r = await resolveNextMdx(${JSON.stringify(baseUrl)}, "./next.config.mjs");\n` +
      `console.log(JSON.stringify(r === undefined ? "undefined" : "options"));\n`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--allow-read",
      "--allow-env",
      `--allow-write=${join(dir, ".denext")}`,
      script,
    ],
    env: { NO_COLOR: "1", DENEXT_PHASE: "", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  assertEquals(out.code, 0, dec.decode(out.stderr));
  return { result: JSON.parse(dec.decode(out.stdout).trim()), stderr: dec.decode(out.stderr) };
}

Deno.test("resolveNextMdx skips the probe quietly without write access beside next.config", async () => {
  // A migrated app's least-privilege `start` evaluates denext.config.ts, whose `mdx` field runs
  // this recovery; the build already compiled the MDX, so start skips it without a warning
  // (up to 4.6.0 it warned "could not recover MDX plugins … Requires write access" on every start).
  const dir = await Deno.makeTempDir({ prefix: "denext_mdxrec_ro_" });
  try {
    await Deno.writeTextFile(
      join(dir, "next.config.mjs"),
      `import createMDX from "@next/mdx";\n` +
        `export default createMDX({ options: { remarkPlugins: [() => (t) => t] } })({});\n`,
    );
    const serving = await recoverWithoutWrite(dir);
    assertEquals(serving.result, "undefined");
    assert(!serving.stderr.includes("MDX"), serving.stderr);
    // Building without the grant still says the MDX pages get the baseline plugins.
    const building = await recoverWithoutWrite(dir, { DENEXT_PHASE: "build" });
    assertEquals(building.result, "undefined");
    assert(building.stderr.includes("could not recover MDX plugins"), building.stderr);
    const leftover = [...Deno.readDirSync(dir)].some((e) => e.name.includes("denext-mdx-probe"));
    assert(!leftover, "no probe written");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
