// Tailwind integration: platform → asset mapping, path resolution, and the
// buildAppCss compile+exclude behavior (driven through a stub binary so no real
// download/network is needed).

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { machoFixture, sha256Hex } from "./helpers/macho-fixture.ts";
import { join, toFileUrl } from "@std/path";
import {
  compileTailwind,
  DEFAULT_TAILWIND_VERSION,
  resolveTailwindBin,
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
  // No Windows Arm64 build is published (its URL is a 404): Windows on Arm runs the x64 one.
  assertEquals(tailwindAssetName("windows", "aarch64"), "tailwindcss-windows-x64.exe");
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
  // Absolute local paths as this OS resolves them (`C:\proj\…` on Windows).
  const proj = Deno.build.os === "windows" ? "C:\\proj" : "/proj";
  assertEquals(tailwindPaths(proj, null), undefined);
  assertEquals(
    tailwindPaths(proj, { input: "styles/tw.css", output: "app/globals.css" }),
    { input: join(proj, "styles", "tw.css"), output: join(proj, "app", "globals.css") },
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
  // The Tailwind step resolved the raw import: none reaches the route's stylesheet.
  assert(!routeCss.includes("tailwindcss"), routeCss);
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

/**
 * Run `fn` with a custom Tailwind version pinned to `pin` (the env a custom release needs) and a
 * fresh cache directory, restoring the environment after.
 */
async function withPinnedVersion(
  version: string,
  pin: string,
  fn: (cacheDir: string) => Promise<void>,
): Promise<void> {
  const keys = ["DENEXT_TAILWIND_VERSION", "DENEXT_TAILWIND_SHA256", "TAILWIND_BIN"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  const cacheDir = await Deno.makeTempDir({ prefix: "denext_tw_sig_" });
  try {
    Deno.env.set("DENEXT_TAILWIND_VERSION", version);
    Deno.env.set("DENEXT_TAILWIND_SHA256", pin);
    Deno.env.delete("TAILWIND_BIN");
    await fn(cacheDir);
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(cacheDir, { recursive: true });
  }
}

/** A fetch that serves `bytes` and counts its calls. */
function countingFetch(bytes: Uint8Array): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(new Response(bytes.slice()));
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => calls };
}

// Tailwind's macOS releases are Bun-compiled with a stale hash for the last page before their
// ad-hoc signature, and macOS 27 on Apple Silicon SIGKILLs v4.3.0 at launch (exit 137) for it.
Deno.test("resolveTailwindBin: on macOS the verified download is cached with its signature repaired", async () => {
  const good = await machoFixture();
  const published = await machoFixture({ stale: [good.pages - 1] });
  await withPinnedVersion("v0.0.0-sig", await sha256Hex(published.bytes), async (cacheDir) => {
    const served = countingFetch(published.bytes);
    const options = { cacheDir, os: "darwin", arch: "aarch64", fetch: served.fetch, log: () => {} };
    const bin = await resolveTailwindBin(options);
    assertEquals(await Deno.readFile(bin), good.bytes);
    assertEquals(served.calls(), 1);
    // The repaired binary is what this process verified: no second download.
    assertEquals(await resolveTailwindBin(options), bin);
    assertEquals(served.calls(), 1);
  });
});

Deno.test("resolveTailwindBin: a published macOS asset already in the cache is repaired in place", async () => {
  const good = await machoFixture();
  const published = await machoFixture({ stale: [good.pages - 1] });
  await withPinnedVersion(
    "v0.0.0-sig-cached",
    await sha256Hex(published.bytes),
    async (cacheDir) => {
      const dest = join(cacheDir, "tailwindcss");
      await Deno.writeFile(dest, published.bytes, { mode: 0o755 }); // what an older denext cached
      const served = countingFetch(published.bytes);
      const bin = await resolveTailwindBin({
        cacheDir,
        os: "darwin",
        arch: "aarch64",
        fetch: served.fetch,
        log: () => {},
      });
      assertEquals(bin, dest);
      assertEquals(served.calls(), 0);
      assertEquals(await Deno.readFile(dest), good.bytes);
    },
  );
});

Deno.test("resolveTailwindBin: off macOS the asset is cached exactly as published", async () => {
  const published = await machoFixture({ stale: [0] });
  await withPinnedVersion(
    "v0.0.0-sig-linux",
    await sha256Hex(published.bytes),
    async (cacheDir) => {
      const served = countingFetch(published.bytes);
      const options = { cacheDir, os: "linux", arch: "x86_64", fetch: served.fetch, log: () => {} };
      const bin = await resolveTailwindBin(options);
      assertEquals(await Deno.readFile(bin), published.bytes);
      await resolveTailwindBin(options);
      assertEquals(served.calls(), 1);
    },
  );
});

Deno.test("resolveTailwindBin: a cached binary of a version with no pin is refused", async () => {
  const keys = ["DENEXT_TAILWIND_VERSION", "DENEXT_TAILWIND_SHA256", "TAILWIND_BIN"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  const cacheDir = await Deno.makeTempDir({ prefix: "denext_tw_nopin_" });
  try {
    Deno.env.set("DENEXT_TAILWIND_VERSION", "v0.0.0-nopin");
    Deno.env.delete("DENEXT_TAILWIND_SHA256");
    Deno.env.delete("TAILWIND_BIN");
    await Deno.writeTextFile(join(cacheDir, "tailwindcss"), "#!/bin/sh\n");
    const served = countingFetch(new Uint8Array());
    await assertRejects(
      () => resolveTailwindBin({ cacheDir, os: "linux", arch: "x86_64", fetch: served.fetch }),
      Error,
      "no pinned sha256",
    );
    assertEquals(served.calls(), 0);
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("resolveTailwindBin: a failed download names the overrides", async () => {
  await withPinnedVersion("v0.0.0-404", "00", async (cacheDir) => {
    const notFound = (() =>
      Promise.resolve(
        new Response("nope", { status: 404, statusText: "Not Found" }),
      )) as typeof fetch;
    await assertRejects(
      () =>
        resolveTailwindBin({
          cacheDir,
          os: "linux",
          arch: "x86_64",
          fetch: notFound,
          log: () => {},
        }),
      Error,
      "TAILWIND_BIN",
    );
  });
});

// A Tailwind v3 install is compiled with its own CLI through `deno run npm:tailwindcss@3`; a stub
// `DENO_BIN` stands in for Deno, so no npm download happens. POSIX only.
Deno.test({
  name:
    "compileTailwind: a v3 install runs its own CLI, retrying without a PostCSS config that fails",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_tw_v3_" });
    const prev = Deno.env.get("DENO_BIN");
    try {
      await Deno.mkdir(join(dir, "node_modules", "tailwindcss"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "node_modules", "tailwindcss", "package.json"),
        JSON.stringify({ version: "3.4.17" }),
      );
      await Deno.writeTextFile(join(dir, "postcss.config.js"), "export default {};\n");
      const log = join(dir, "calls.log");
      const stub = join(dir, "deno-stub.sh");
      // Fails while `--postcss` is passed; else writes the output (the arg after `-o`).
      await Deno.writeTextFile(
        stub,
        `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *--postcss*) echo 'postcss broke' >&2; exit 1;; esac\n` +
          `while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then printf 'v3css' > "$2"; fi; shift; done\n`,
      );
      await Deno.chmod(stub, 0o755);
      Deno.env.set("DENO_BIN", stub);
      const output = join(dir, "out.css");
      await compileTailwind({ input: join(dir, "in.css"), output, projectDir: dir, minify: true });
      assertEquals(await Deno.readTextFile(output), "v3css");
      const calls = (await Deno.readTextFile(log)).trim().split("\n");
      assertEquals(calls.length, 2);
      assertStringIncludes(calls[0], "npm:tailwindcss@3.4.17");
      assertStringIncludes(calls[0], "--postcss");
      assert(!calls[1].includes("--postcss"), calls[1]);
      assertStringIncludes(calls[1], "--minify");

      // Both attempts failing reports the CLI's error.
      await Deno.writeTextFile(stub, "#!/bin/sh\necho 'v3 exploded' >&2\nexit 2\n");
      await assertRejects(
        () => compileTailwind({ input: join(dir, "in.css"), output, projectDir: dir }),
        Error,
        "v3 exploded",
      );
    } finally {
      if (prev === undefined) Deno.env.delete("DENO_BIN");
      else Deno.env.set("DENO_BIN", prev);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "compileTailwind: a standalone binary's failure is reported with its stderr",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_tw_fail_" });
    try {
      const bin = join(dir, "tw.sh");
      await Deno.writeTextFile(bin, "#!/bin/sh\necho 'bad input' >&2\nexit 3\n");
      await Deno.chmod(bin, 0o755);
      await assertRejects(
        () => compileTailwind({ input: "in.css", output: "out.css", cwd: dir, bin, minify: true }),
        Error,
        "Tailwind compile failed (3)",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
