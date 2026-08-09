// Full-build smoke test: run the real production `build()` on examples/hello and
// assert the on-disk artifact shape. This is the tripwire for the experimental
// `deno bundle` subcommand — if a future Deno changes its output (entry name,
// code-split chunk emission), this fails loudly instead of silently shipping a
// broken client bundle. It also covers the ssr:false code-split path end to end.

import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { build } from "../src/build/build.ts";

const BUNDLE_URL = new URL("../src/build/bundle.ts", import.meta.url).href;

const EXAMPLE = new URL("../examples/hello", import.meta.url).pathname;

Deno.test("build smoke: examples/hello emits a client entry, a code-split island chunk, and a shared chunk", async () => {
  const result = await build(EXAMPLE);
  const clientDir = join(result.outDir, "client");

  const files: string[] = [];
  for await (const entry of Deno.readDir(clientDir)) {
    if (entry.isFile) files.push(entry.name);
  }
  const list = files.join(", ");

  // The home route's client entry.
  assert(files.includes("index.js"), `expected index.js in client output; got: ${list}`);
  // `dynamic(() => import("./island.tsx"), { ssr: false })` is split into its own chunk.
  assert(
    files.some((f) => f.startsWith("island-") && f.endsWith(".js")),
    `expected a code-split island-*.js chunk; got: ${list}`,
  );
  // Code-splitting hoists shared modules (the client runtime) into a common chunk.
  assert(
    files.some((f) => f.startsWith("chunk-") && f.endsWith(".js")),
    `expected a shared chunk-*.js; got: ${list}`,
  );

  // The build manifest is written.
  const manifest = JSON.parse(await Deno.readTextFile(join(result.outDir, "manifest.json")));
  assert(Array.isArray(manifest.generatedRoutes), "manifest should list generated routes");

  // The entry wires up hydration against the server-rendered root.
  const entry = await Deno.readTextFile(join(clientDir, "index.js"));
  assertStringIncludes(entry, "__denext");
});

// The probe is memoized per process, so run it in a subprocess with DENO_BIN
// pointed at a fake `deno` that reports an unsupported version. (POSIX only:
// the fake is a shell script.)
Deno.test({
  name: "bundle support probe rejects an old Deno with a clear, actionable error",
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_fakedeno_" });
  try {
    const fake = join(dir, "deno");
    await Deno.writeTextFile(fake, "#!/bin/sh\necho 'deno 1.40.0 (stable, release)'\n");
    await Deno.chmod(fake, 0o755);

    const code = `Deno.env.set("DENO_BIN", ${JSON.stringify(fake)});` +
      `const { ensureBundleSupport } = await import(${JSON.stringify(BUNDLE_URL)});` +
      `try { await ensureBundleSupport(); console.log("NO_ERROR"); }` +
      `catch (e) { console.log("ERR:" + e.message); }`;

    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", code],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);

    assertStringIncludes(text, "requires Deno 2");
    assertStringIncludes(text, "DENO_BIN");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
