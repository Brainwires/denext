// Tailwind integration: platform → asset mapping, path resolution, and the
// buildAppCss compile+exclude behavior (driven through a stub binary so no real
// download/network is needed).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  tailwindAssetName,
  tailwindDownloadUrl,
  tailwindPaths,
  tailwindVersion,
} from "../src/build/tailwind.ts";
import { buildAppCss } from "../src/build/css.ts";

Deno.test("tailwindAssetName maps os/arch to release assets", () => {
  assertEquals(tailwindAssetName("darwin", "aarch64"), "tailwindcss-macos-arm64");
  assertEquals(tailwindAssetName("darwin", "x86_64"), "tailwindcss-macos-x64");
  assertEquals(tailwindAssetName("linux", "x86_64"), "tailwindcss-linux-x64");
  assertEquals(tailwindAssetName("linux", "aarch64"), "tailwindcss-linux-arm64");
  assertEquals(tailwindAssetName("windows", "x86_64"), "tailwindcss-windows-x64.exe");
  assertThrows(() => tailwindAssetName("plan9", "x86_64"), Error, "unsupported OS");
  assertThrows(() => tailwindAssetName("linux", "sparc"), Error, "unsupported architecture");
});

Deno.test("tailwindDownloadUrl points at the GitHub release asset", () => {
  assertEquals(
    tailwindDownloadUrl("v4.1.11", "tailwindcss-linux-x64"),
    "https://github.com/tailwindlabs/tailwindcss/releases/download/v4.1.11/tailwindcss-linux-x64",
  );
});

Deno.test("tailwindVersion honors DENEXT_TAILWIND_VERSION", () => {
  const prev = Deno.env.get("DENEXT_TAILWIND_VERSION");
  try {
    Deno.env.set("DENEXT_TAILWIND_VERSION", "v4.9.9");
    assertEquals(tailwindVersion(), "v4.9.9");
    Deno.env.delete("DENEXT_TAILWIND_VERSION");
    assert(tailwindVersion().startsWith("v4."));
  } finally {
    if (prev === undefined) Deno.env.delete("DENEXT_TAILWIND_VERSION");
    else Deno.env.set("DENEXT_TAILWIND_VERSION", prev);
  }
});

Deno.test("tailwindPaths resolves relative input/output against the project", () => {
  assertEquals(tailwindPaths("/proj", null), undefined);
  assertEquals(
    tailwindPaths("/proj", { input: "styles/tw.css", output: "app/globals.css" }),
    { input: "/proj/styles/tw.css", output: "/proj/app/globals.css" },
  );
});

// A stub Tailwind binary: a tiny shell script that honors `-i`/`-o`, so the whole
// buildAppCss compile+exclude path runs without a real download. POSIX only.
Deno.test({
  name: "buildAppCss compiles Tailwind and excludes the input from the walk",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_tw_" });
    const prevBin = Deno.env.get("TAILWIND_BIN");
    try {
      // Project: a Tailwind input (raw directives) + one ordinary stylesheet.
      await Deno.mkdir(join(dir, "styles"), { recursive: true });
      await Deno.mkdir(join(dir, "app"), { recursive: true });
      await Deno.writeTextFile(join(dir, "styles", "tailwind.css"), '@import "tailwindcss";\n');
      await Deno.writeTextFile(join(dir, "app", "site.css"), ".site{color:blue}\n");

      const stub = join(dir, "tw-stub.sh");
      await Deno.writeTextFile(
        stub,
        `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -i) IN="$2"; shift 2;;
    -o) OUT="$2"; shift 2;;
    --minify) shift;;
    *) shift;;
  esac
done
printf '.tw-generated{color:green}\\n' > "$OUT"
`,
      );
      await Deno.chmod(stub, 0o755);
      Deno.env.set("TAILWIND_BIN", stub);

      const outDir = join(dir, ".denext");
      const assets = await buildAppCss({
        projectDir: dir,
        configPath: join(dir, "deno.json"),
        outDir,
        tailwind: {
          input: join(dir, "styles", "tailwind.css"),
          output: join(dir, "app", "globals.css"),
        },
      });
      assert(assets, "expected CSS assets");

      // The compiled output exists and contains the stub's generated CSS.
      const compiled = await Deno.readTextFile(join(dir, "app", "globals.css"));
      assertStringIncludes(compiled, ".tw-generated");

      // The raw Tailwind INPUT must be excluded from the pipeline; the compiled
      // OUTPUT and the ordinary stylesheet are included.
      assert(
        !assets.cssFiles.includes(join(dir, "styles", "tailwind.css")),
        "the Tailwind input must be excluded from the walk",
      );
      assert(assets.cssFiles.includes(join(dir, "app", "globals.css")), "output included");
      assert(assets.cssFiles.includes(join(dir, "app", "site.css")), "ordinary css included");
    } finally {
      if (prevBin === undefined) Deno.env.delete("TAILWIND_BIN");
      else Deno.env.set("TAILWIND_BIN", prevBin);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
