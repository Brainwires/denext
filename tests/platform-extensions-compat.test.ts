// Platform-specific files on the esbuild paths: SPA mode (its native `deno bundle` path and its
// compat esbuild path) and a next-compat App Router app (esbuild client AND SSR bundles) pick
// the target's variant (`label.ios.ts`) in a platform export, drop the others, and fail with a
// message naming the variants when the target has no file.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import type { Platform } from "../src/build/platform-extensions.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

/** A throwaway project: a deno.json aliasing `denext` to this checkout, plus `files`. */
async function project(
  files: Record<string, string>,
  imports: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_esbuild_" });
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

/** The export's HTML and every client `.js` file, concatenated. */
async function exported(outDir: string): Promise<{ html: string; js: string }> {
  const client = join(outDir, "_denext", "client");
  let js = "";
  for await (const e of Deno.readDir(client)) {
    if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(client, e.name));
  }
  return { html: await Deno.readTextFile(join(outDir, "index.html")), js };
}

const LABELS = ["PLAIN_LABEL", "IOS_LABEL", "DESKTOP_LABEL", "WEB_LABEL"];

/** `src/label*.ts` exporting each label, minus the ones `omit` names. */
function labelFiles(dir: string, omit: string[] = []): Record<string, string> {
  const all: Record<string, string> = {
    [`${dir}/label.ts`]: `export const label = "PLAIN_LABEL";\n`,
    [`${dir}/label.ios.ts`]: `export const label = "IOS_LABEL";\n`,
    [`${dir}/label.desktop.ts`]: `export const label = "DESKTOP_LABEL";\n`,
    [`${dir}/label.web.ts`]: `export const label = "WEB_LABEL";\n`,
  };
  for (const o of omit) delete all[`${dir}/label${o}.ts`];
  return all;
}

/** A SPA whose entry imports `./label` (extensionless) and logs it. */
function spa(compat: boolean, omit: string[] = []): Record<string, string> {
  return {
    "denext.config.ts": `export default { mode: "spa", spa: { entry: "./src/main.ts" }${
      compat ? ", compatibilityMode: true" : ""
    } };\n`,
    "src/main.ts": `import { label } from "./label";\nconsole.log(label);\n`,
    ...labelFiles("src", omit),
  };
}

const CASES: ReadonlyArray<readonly [Platform, string]> = [
  ["web", "WEB_LABEL"],
  ["ios", "IOS_LABEL"],
  ["android", "WEB_LABEL"],
  ["windows", "DESKTOP_LABEL"],
];

for (const compat of [false, true]) {
  const path = compat ? "compat (esbuild)" : "native (deno bundle)";
  for (const [platform, want] of CASES) {
    Deno.test(`SPA ${path} export --platform ${platform} bundles ${want} only`, async () => {
      const dir = await project(spa(compat));
      try {
        const out = (await staticExport(dir, { platform })).outDir;
        const { js } = await exported(out);
        const stamp = await Deno.readTextFile(join(out, "_denext", "platform.txt")).catch(() =>
          null
        );
        assertEquals(stamp, platform === "web" ? null : platform, "the SPA export's stamp");
        assertStringIncludes(js, want);
        for (const other of LABELS.filter((l) => l !== want)) {
          assert(!js.includes(other), `${other} bundled for ${platform}`);
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
}

Deno.test("SPA compat export: a module with no file for the target fails naming its variants", async () => {
  const dir = await project(spa(true, ["", ".web", ".desktop"]));
  try {
    const err = await assertRejects(() => staticExport(dir, { platform: "android" }));
    assertStringIncludes(
      (err as Error).message,
      "`./label` has `.ios` variant but none for android: add `label.ts` or `label.android.ts`",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A next-compat App Router app: a server page renders a `"use client"` island with the label. */
const COMPAT_APP = {
  "denext.config.ts": `export default { compatibilityMode: true };\n`,
  "app/page.tsx": `import { Island } from "./island";\n` +
    `export default function Page(){ return <main><Island/></main>; }\n`,
  "app/island.tsx": `"use client"\nimport { useState } from "denext";\n` +
    `import { label } from "./label";\n` +
    `export function Island(){ const [n] = useState(0); return <b>{label}{n}</b>; }\n`,
  ...labelFiles("app"),
};

for (const [platform, want] of CASES) {
  Deno.test(`next-compat App Router export --platform ${platform} renders and bundles ${want}`, async () => {
    const dir = await project(COMPAT_APP);
    try {
      const got = await exported((await staticExport(dir, { platform })).outDir);
      assertStringIncludes(got.html, want, "the SSR bundle picked the variant");
      assertStringIncludes(got.js, want, "the client bundle picked the variant");
      for (const other of LABELS.filter((l) => l !== want)) {
        assert(!got.html.includes(other), `${other} rendered for ${platform}`);
        assert(!got.js.includes(other), `${other} bundled for ${platform}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

/** COMPAT_APP and the SPA, importing the label through the app's import map (`@/`, `#label`). */
const ALIAS_IMPORTS = { "@/": "./", "#label": "./src/label.ts" };

for (const [platform, want] of CASES) {
  Deno.test(`next-compat App Router export --platform ${platform}: an import-map alias takes ${want}`, async () => {
    const dir = await project({
      ...COMPAT_APP,
      "app/island.tsx": COMPAT_APP["app/island.tsx"].replace(`"./label"`, `"@/app/label"`),
    }, ALIAS_IMPORTS);
    try {
      const got = await exported((await staticExport(dir, { platform })).outDir);
      assertStringIncludes(got.html, want, "the SSR bundle picked the variant");
      assertStringIncludes(got.js, want, "the client bundle picked the variant");
      for (const other of LABELS.filter((l) => l !== want)) {
        assert(!got.html.includes(other) && !got.js.includes(other), `${other} for ${platform}`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  for (const compat of [false, true]) {
    const path = compat ? "compat (esbuild)" : "native (deno bundle)";
    Deno.test(`SPA ${path} export --platform ${platform}: an import-map alias takes ${want}`, async () => {
      const dir = await project({
        ...spa(compat),
        "src/main.ts": `import { label } from "#label";\nconsole.log(label);\n`,
      }, ALIAS_IMPORTS);
      try {
        const { js } = await exported((await staticExport(dir, { platform })).outDir);
        assertStringIncludes(js, want);
        for (const other of LABELS.filter((l) => l !== want)) assert(!js.includes(other), other);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
}

/**
 * A package shipping React Native's platform files (`Foo.ios.js`, `Foo.web.js`), reached through
 * a relative import inside it, beside the app's own `label` files.
 */
function withPackage(reactNative: boolean, platformExtensions: string): Record<string, string> {
  return {
    ...spa(true, [".desktop"]),
    "denext.config.ts": `export default { mode: "spa", spa: { entry: "./src/main.ts" }, ` +
      `compatibilityMode: true, reactNative: ${reactNative}, ` +
      `platformExtensions: ${platformExtensions} };\n`,
    "src/main.ts": `import { label } from "./label";\nimport { x } from "rnlib";\n` +
      `console.log(label, x);\n`,
    "node_modules/rnlib/package.json": JSON.stringify({
      name: "rnlib",
      version: "1.0.0",
      main: "lib/index.js",
    }),
    "node_modules/rnlib/lib/index.js": `export * from "./Foo";\n`,
    "node_modules/rnlib/lib/Foo.js": `export const x = "PKG_PLAIN";\n`,
    "node_modules/rnlib/lib/Foo.ios.js": `export const x = "PKG_IOS";\n`,
    "node_modules/rnlib/lib/Foo.web.js": `export const x = "PKG_WEB";\n`,
  };
}

// [React Native mode, platformExtensions, target, the app's file, the package's file]
const PACKAGE_CASES: ReadonlyArray<readonly [boolean, string, Platform, string, string]> = [
  // A package keeps its own resolution: plain outside React Native mode…
  [false, "true", "ios", "IOS_LABEL", "PKG_PLAIN"],
  [false, "true", "web", "WEB_LABEL", "PKG_PLAIN"],
  // …its `.web` build in React Native mode, as before platform files.
  [true, "true", "web", "WEB_LABEL", "PKG_WEB"],
  // React Native mode: the app's `.ios` files are native code, opt-in with `osFiles`.
  [true, "true", "ios", "WEB_LABEL", "PKG_WEB"],
  [true, "{ osFiles: true }", "ios", "IOS_LABEL", "PKG_WEB"],
];

for (const [reactNative, option, platform, wantApp, wantPkg] of PACKAGE_CASES) {
  const mode = reactNative ? "React Native mode" : "SPA";
  Deno.test(`${mode} export --platform ${platform} (platformExtensions: ${option}): app ${wantApp}, package ${wantPkg}`, async () => {
    const dir = await project(withPackage(reactNative, option));
    try {
      const { js } = await exported((await staticExport(dir, { platform })).outDir);
      assertStringIncludes(js, wantApp);
      assertStringIncludes(js, wantPkg);
      const others = [...LABELS, "PKG_PLAIN", "PKG_IOS", "PKG_WEB"];
      for (const other of others.filter((l) => l !== wantApp && l !== wantPkg)) {
        assert(!js.includes(other), `${other} bundled`);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
