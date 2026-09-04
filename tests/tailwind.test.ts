// Tailwind integration: platform → asset mapping, path resolution, and the
// buildAppCss compile+exclude behavior (driven through a stub binary so no real
// download/network is needed).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  DEFAULT_TAILWIND_VERSION,
  tailwindAssetName,
  tailwindDownloadUrl,
  tailwindPaths,
  tailwindVersion,
} from "../src/build/tailwind.ts";
import { buildAppCss, extractRouteCss } from "../src/build/css.ts";

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

// The bundled Tailwind must not regress below v4.3.0: earlier v4.x standalone
// releases (e.g. v4.1.11) lack the logical inset shorthands `inset-s-*`/`inset-e-*`
// (`inset-inline-start/end`), so a class like `inset-e-2.5` compiles to nothing and
// an `absolute` element pinned by it collapses to its static position. Real
// Tailwind 4.3.0 (what Vite apps use) emits them; the default pin must match.
Deno.test("bundled Tailwind is >= v4.3.0 (has inset-s/inset-e logical utilities)", () => {
  const m = DEFAULT_TAILWIND_VERSION.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  assert(m, `unexpected version format: ${DEFAULT_TAILWIND_VERSION}`);
  const [major, minor] = [Number(m![1]), Number(m![2])];
  assert(
    major > 4 || (major === 4 && minor >= 3),
    `Tailwind pin ${DEFAULT_TAILWIND_VERSION} predates inset-e-* (need >= v4.3.0)`,
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

type CssAssets = NonNullable<Awaited<ReturnType<typeof buildAppCss>>>;

/** Project: a Tailwind input (raw directives) + one ordinary stylesheet + the stub binary. */
async function writeStubProject(dir: string): Promise<string> {
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
  return stub;
}

/** The compiled output exists; the raw input is excluded while output + ordinary css are in. */
async function assertCompiledAndExcluded(dir: string, assets: CssAssets): Promise<void> {
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
}

/** An app importing the Tailwind INPUT it authored still gets the compiled stylesheet. */
async function assertInputAliasedToOutput(dir: string, assets: CssAssets): Promise<void> {
  // An app that imports the Tailwind INPUT it authored (`import "./tailwind.css"`)
  // must still get the compiled stylesheet: the input is aliased to the output, so
  // it resolves to the same shim (bundler) AND collects the same compiled CSS.
  const inURL = toFileUrl(join(dir, "styles", "tailwind.css")).href;
  const outURL = toFileUrl(join(dir, "app", "globals.css")).href;
  assertEquals(
    assets.importMap[inURL],
    assets.importMap[outURL],
    "the Tailwind input resolves to the output's shim",
  );
  await Deno.writeTextFile(
    join(dir, "app", "usesInput.tsx"),
    `import "../styles/tailwind.css";\nexport default function P() { return null; }\n`,
  );
  const routeCss = await extractRouteCss([join(dir, "app", "usesInput.tsx")], assets);
  assertStringIncludes(
    routeCss,
    ".tw-generated",
    "importing the Tailwind input collects the compiled output CSS (not an unstyled build)",
  );
}

// A stub Tailwind binary: a tiny shell script that honors `-i`/`-o`, so the whole
// buildAppCss compile+exclude path runs without a real download. POSIX only.
Deno.test({
  name: "buildAppCss compiles Tailwind and excludes the input from the walk",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_tw_" });
    const prevBin = Deno.env.get("TAILWIND_BIN");
    try {
      const stub = await writeStubProject(dir);
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

      await assertCompiledAndExcluded(dir, assets);
      await assertInputAliasedToOutput(dir, assets);
    } finally {
      if (prevBin === undefined) Deno.env.delete("TAILWIND_BIN");
      else Deno.env.set("TAILWIND_BIN", prevBin);
      await Deno.remove(dir, { recursive: true });
    }
  },
});
