// denext 5.0's library entry points — `build()`, `createTestApp()` and `probeApp()` — refuse a Deno
// that is not denext's runtime up front, with a `denext:` error naming the 5.0 change and
// `denext toolchain install` (src/build/deno-version.ts `requireDenextRuntime`). The unit half
// checks the decision; the end-to-end half runs the three entry points on a stock `deno` from PATH
// when one is there (a developer machine, a CI runner with setup-deno), where they used to run on.

import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import { DELIMITER, fromFileUrl, join } from "@std/path";
import {
  denoBinaryIdentity,
  isSupportedDenextRuntime,
  MIN_DENEXT_RUNTIME,
  requireDenextRuntime,
} from "../src/build/deno-version.ts";

Deno.test("requireDenextRuntime: upstream Deno is refused, naming the entry, 5.0 and the fix", () => {
  const err = assertThrows(
    () => requireDenextRuntime("createTestApp()", { deno: "2.9.8" }),
    Error,
  );
  assertStringIncludes(err.message, "denext: createTestApp() needs denext's Deno runtime");
  assertStringIncludes(err.message, "upstream Deno 2.9.8");
  assertStringIncludes(err.message, "denext 5.0");
  assertStringIncludes(err.message, "denext toolchain install");
  // Upstream's own 3.0.0 is not denext's either: the marker decides, not the number.
  assertThrows(() => requireDenextRuntime("build()", { deno: "3.0.0" }), Error, "upstream Deno");
});

Deno.test("requireDenextRuntime: denext's Deno older than the minimum is refused", () => {
  assertThrows(
    () => requireDenextRuntime("probeApp()", { deno: "3.0.0-rc.3", denext: "3.0.0-rc.3" }),
    Error,
    `older than ${MIN_DENEXT_RUNTIME}`,
  );
});

Deno.test("requireDenextRuntime: the minimum runtime and later pass, and so does this process", () => {
  requireDenextRuntime("build()", { deno: MIN_DENEXT_RUNTIME, denext: MIN_DENEXT_RUNTIME });
  requireDenextRuntime("build()", { deno: "3.0.0", denext: "3.0.0" });
  // The suite runs on the toolchain (scripts/test-run.ts); the second call is the memoized one.
  requireDenextRuntime("build()");
  requireDenextRuntime("build()");
});

/** A `deno` on PATH that is not denext's runtime, or `null`. */
async function stockDenoOnPath(): Promise<string | null> {
  const name = Deno.build.os === "windows" ? "deno.exe" : "deno";
  for (const dir of (Deno.env.get("PATH") ?? "").split(DELIMITER)) {
    const candidate = join(dir, name);
    if (await isStockDeno(candidate)) return candidate;
  }
  return null;
}

/** Whether `path` is a runnable `deno` that is not denext's runtime. */
async function isStockDeno(path: string): Promise<boolean> {
  const info = await Deno.stat(path).catch(() => null);
  if (!info?.isFile || info.size === 0) return false;
  const identity = await denoBinaryIdentity(path);
  return identity !== null && !isSupportedDenextRuntime(identity);
}

const stock = await stockDenoOnPath();

Deno.test({
  name: "build(), createTestApp() and probeApp() refuse a stock Deno before doing any work",
  ignore: stock === null,
  sanitizeResources: false,
  fn: async () => {
    const root = fromFileUrl(new URL("../", import.meta.url));
    const project = await Deno.makeTempDir({ prefix: "denext-require-runtime-" });
    try {
      const script = join(project, "probe.ts");
      const src = (path: string) => JSON.stringify(new URL(`../src/${path}`, import.meta.url).href);
      await Deno.writeTextFile(
        script,
        `const { createTestApp } = await import(${src("testing/mod.ts")});\n` +
          `const { probeApp } = await import(${src("testing/conformance.ts")});\n` +
          `const { build } = await import(${src("build/build.ts")});\n` +
          `const dir = ${JSON.stringify(project)};\n` +
          "for (const run of [() => createTestApp(dir), () => probeApp(dir), () => build(dir)]) {\n" +
          "  try { await run(); console.log('ran'); }\n" +
          "  catch (e) { console.log(String(e).split('\\n')[0]); }\n" +
          "}\n",
      );
      const out = await new Deno.Command(stock!, {
        args: ["run", "-A", "--quiet", "--config", join(root, "deno.json"), script],
        cwd: root,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(out.stdout);
      assert(out.success, new TextDecoder().decode(out.stderr));
      for (const entry of ["createTestApp()", "probeApp()", "build()"]) {
        assertStringIncludes(text, `denext: ${entry} needs denext's Deno runtime`);
      }
      assert(!text.includes("ran"), text);
    } finally {
      await Deno.remove(project, { recursive: true }).catch(() => {});
    }
  },
});
