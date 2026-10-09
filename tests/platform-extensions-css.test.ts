// A stylesheet (or another asset) that only a platform file imports belongs to the targets that
// load that file: `look.mobile.ts`'s `import "./mobile.css"` reaches the iOS and Android builds'
// CSS, and the plain `look.ts`'s sheet does not. The stylesheet crawl follows the target's
// resolved graph on every path — SPA (native `deno bundle` and compat esbuild), the native and
// next-compat App Router, `denext build`, and dev (bundled and unbundled) — as the JS does.

import { assert, assertStringIncludes } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import { build } from "../src/build/build.ts";
import { startDevServer } from "../src/build/dev-server.ts";
import { startSpaDevServer } from "../src/build/spa/dev-server.ts";
import { resolveProject } from "../src/build/paths.ts";
import type { Platform } from "../src/build/platform-extensions.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** A throwaway project: a deno.json aliasing `denext` to this checkout, plus `files`. */
async function project(
  files: Record<string, string>,
  imports: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_platform_css_" }));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
        ...imports,
      },
    }),
  );
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

/** The variants of `look`: each imports its own stylesheet (`.<name>-sheet`). */
const VARIANTS = ["plain", "web", "mobile", "desktop"] as const;
type Variant = typeof VARIANTS[number];

/** `<dir>/look*.ts` and their sheets, minus the variants `omit` names. */
function lookFiles(dir: string, omit: readonly Variant[] = []): Record<string, string> {
  const files: Record<string, string> = {};
  for (const v of VARIANTS) {
    if (omit.includes(v)) continue;
    const file = v === "plain" ? "look.ts" : `look.${v}.ts`;
    files[`${dir}/${file}`] = `import "./${v}.css";\nexport const look = "${v}";\n`;
    files[`${dir}/${v}.css`] = `.${v}-sheet { color: red; }\n`;
  }
  return files;
}

/** Every `.css` file under `dir`, concatenated. */
async function allCss(dir: string): Promise<string> {
  let css = "";
  for await (const e of walk(dir, { exts: [".css"], includeDirs: false })) {
    css += await Deno.readTextFile(e.path);
  }
  return css;
}

/** Assert `css` carries `want`'s sheet and no other variant's. */
function assertSheet(css: string, want: Variant, where: string) {
  assertStringIncludes(css, `.${want}-sheet`, `${where}: the ${want} file's stylesheet`);
  for (const other of VARIANTS.filter((v) => v !== want)) {
    assert(!css.includes(`.${other}-sheet`), `${where}: ${other}.css leaked in`);
  }
}

const CASES: ReadonlyArray<readonly [Platform, Variant]> = [
  ["web", "web"],
  ["ios", "mobile"],
  ["android", "mobile"],
  ["macos", "desktop"],
];

/** A SPA whose entry imports `./look` (extensionless). */
function spa(compat: boolean): Record<string, string> {
  return {
    "denext.config.ts": `export default { mode: "spa", spa: { entry: "./src/main.ts" }${
      compat ? ", compatibilityMode: true" : ""
    } };\n`,
    "src/main.ts": `import { look } from "./look";\nconsole.log(look);\n`,
    ...lookFiles("src"),
  };
}

for (const compat of [false, true]) {
  const path = compat ? "compat (esbuild)" : "native (deno bundle)";
  for (const [platform, want] of CASES) {
    Deno.test(`SPA ${path} export --platform ${platform}: the ${want} file's stylesheet only`, async () => {
      const dir = await project(spa(compat));
      try {
        const out = (await staticExport(dir, { platform })).outDir;
        assertSheet(await allCss(out), want, `${platform} export`);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }

  Deno.test(`SPA ${path} export --platform ios: a variant reached through an import-map alias brings its stylesheet`, async () => {
    const dir = await project({
      ...spa(compat),
      "src/main.ts": `import { look } from "#look";\nconsole.log(look);\n`,
    }, { "#look": "./src/look.ts" });
    try {
      const out = (await staticExport(dir, { platform: "ios" })).outDir;
      assertSheet(await allCss(out), "mobile", "ios export");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

/** Every file under `dir` whose bytes include `marker`, by name. */
async function filesWith(dir: string, marker: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of walk(dir, { includeDirs: false })) {
    if ((await Deno.readTextFile(e.path).catch(() => "")).includes(marker)) out.push(e.path);
  }
  return out;
}

Deno.test("SPA compat export --platform ios: a variant's font and `?url` assets are the target's", async () => {
  const files: Record<string, string> = {
    "denext.config.ts":
      `export default { mode: "spa", spa: { entry: "./src/main.ts" }, compatibilityMode: true };\n`,
    "src/main.ts": `import { font, doc } from "./face";\nconsole.log(font, doc);\n`,
  };
  for (const v of ["plain", "mobile"] as const) {
    const file = v === "plain" ? "face.ts" : `face.${v}.ts`;
    files[`src/${file}`] = `import font from "./${v}.woff2";\n` +
      `import doc from "./${v}-doc.txt?url";\nexport { font, doc };\n`;
    files[`src/${v}.woff2`] = `${v.toUpperCase()}_FONT_BYTES`;
    files[`src/${v}-doc.txt`] = `${v.toUpperCase()}_DOC_BYTES`;
  }
  const dir = await project(files);
  try {
    const out = (await staticExport(dir, { platform: "ios" })).outDir;
    assert((await filesWith(out, "MOBILE_FONT_BYTES")).length > 0, "the .mobile file's font");
    assert((await filesWith(out, "MOBILE_DOC_BYTES")).length > 0, "the .mobile file's ?url asset");
    assertEqualsEmpty(await filesWith(out, "PLAIN_FONT_BYTES"), "the plain file's font");
    assertEqualsEmpty(await filesWith(out, "PLAIN_DOC_BYTES"), "the plain file's ?url asset");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function assertEqualsEmpty(found: string[], what: string) {
  assert(found.length === 0, `${what} was emitted: ${found.join(", ")}`);
}

/** An App Router app whose server page imports `../components/look`. */
function appRouter(compat: boolean): Record<string, string> {
  return {
    ...(compat ? { "denext.config.ts": `export default { compatibilityMode: true };\n` } : {}),
    "app/page.tsx": `import { look } from "../components/look";\n` +
      `export default function Page(){ return <main>{look}</main>; }\n`,
    ...lookFiles("components"),
  };
}

/**
 * `denext export --platform` through the CLI: a native App Router server render imports the
 * stylesheet, which the CLI's re-exec resolves to its shim (this process's import map cannot).
 */
async function cliExport(dir: string, platform: Platform): Promise<string> {
  const config = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ ...config, nodeModulesDir: "manual" }),
  );
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", abs("cli.ts"), "export", "--platform", platform, dir],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, log);
  return join(dir, "out");
}

for (const compat of [false, true]) {
  const path = compat ? "next-compat" : "native";
  for (const [platform, want] of CASES) {
    Deno.test(`${path} App Router export --platform ${platform}: the route CSS is the ${want} file's`, async () => {
      const dir = await project(appRouter(compat));
      try {
        const out = compat
          ? (await staticExport(dir, { platform })).outDir
          : await cliExport(dir, platform);
        assertSheet(await allCss(join(out, "_denext")), want, `${platform} export`);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }

  Deno.test(`${path} App Router denext build: the route CSS is the .web file's`, async () => {
    const dir = await project(appRouter(compat));
    try {
      await build(dir);
      assertSheet(await allCss(join(dir, ".denext", "client")), "web", "build");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

/**
 * A dev server over `dir` (the SPA one when `spa`: it takes `unbundled` itself), and a fetcher
 * that names the session's target by cookie.
 */
async function devServer(dir: string, opts: { unbundled?: boolean; spa?: boolean } = {}) {
  const controller = new AbortController();
  const paths = await resolveProject(dir);
  const port = await new Promise<number>((resolve) => {
    const options = {
      paths,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      unbundled: opts.unbundled,
      onListen: ({ port }: { port: number }) => resolve(port),
    };
    if (opts.spa) startSpaDevServer(options);
    else startDevServer(options);
  });
  return {
    text: async (path: string, platform: Platform = "web") => {
      const headers: Record<string, string> = platform === "web"
        ? {}
        : { cookie: `__denext_platform=${platform}` };
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      return await res.text();
    },
    stop: async () => {
      controller.abort();
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

/** The stylesheet a dev page links (`<link rel="stylesheet" href>`), fetched for `platform`. */
async function linkedCss(
  server: Awaited<ReturnType<typeof devServer>>,
  platform: Platform,
): Promise<string> {
  const html = await server.text("/", platform);
  const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)]
    .map((m) => m[1].replaceAll("&amp;", "&"));
  let css = "";
  for (const href of hrefs) css += await server.text(href, platform);
  return css;
}

Deno.test("SPA dev (unbundled): each session's stylesheet follows its own platform files", async () => {
  const dir = await project(spa(true));
  const server = await devServer(dir, { spa: true, unbundled: true });
  try {
    assertSheet(await linkedCss(server, "web"), "web", "web session");
    assertSheet(await linkedCss(server, "ios"), "mobile", "ios session");
    assertSheet(await linkedCss(server, "macos"), "desktop", "macos session");
  } finally {
    await server.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SPA dev (bundled): the stylesheet is the .web file's", async () => {
  const dir = await project(spa(true));
  const server = await devServer(dir, { spa: true, unbundled: false });
  try {
    assertSheet(await linkedCss(server, "web"), "web", "web session");
  } finally {
    await server.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next-compat App Router dev: a session's route CSS follows its own platform files", async () => {
  const dir = await project(appRouter(true));
  const server = await devServer(dir);
  try {
    const css = (p: Platform) => server.text("/_denext/route.css?p=/", p);
    assertSheet(await css("web"), "web", "web session");
    assertSheet(await css("ios"), "mobile", "ios session");
  } finally {
    await server.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
