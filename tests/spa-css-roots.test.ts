// A React Native mode SPA's stylesheet: `index.css` must hold the CSS that expo-router route
// files and `.web.*` platform files import. The crawl behind it (`deno info` from the SPA
// entry) reaches neither: routes are imported only by the generated `expo-router/_ctx`, and
// `./icon` resolves to `icon.tsx` there while the bundle picks `icon.web.tsx`. Found on
// Expo's SDK 57 template (examples/expo-app), whose `@/global.css` (imported by a module the
// routes use) and a web component's CSS module were missing from the export.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { buildAppCss, extractRouteCss } from "../src/build/css.ts";
import { resolveProject } from "../src/build/paths.ts";
import { spaCssRoots } from "../src/build/spa/bundle.ts";

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

Deno.test("spaCssRoots: React Native mode crawls expo-router routes and .web.* files", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_rn_css_" }));
  try {
    await writeTree(dir, {
      "deno.json": JSON.stringify({ unstable: ["sloppy-imports"] }),
      "denext.config.ts":
        `export default { mode: "spa", reactNative: true, spa: { entry: "./index.web.ts" } };\n`,
      // The entry reaches no route (expo-router's context imports them at build time).
      "index.web.ts": "export {};\n",
      "src/app/_layout.tsx":
        'import "../theme.ts";\nexport default function L() { return null; }\n',
      "src/app/index.tsx": 'import { Icon } from "../icon";\nexport default Icon;\n',
      "src/theme.ts": 'import "./global.css";\nexport const theme = 1;\n',
      "src/global.css": ":root { --font-mono: ui-monospace; }\n",
      // `./icon` is icon.tsx to `deno info`; the bundle takes icon.web.tsx.
      "src/icon.tsx": "export const Icon = 1;\n",
      "src/icon.web.tsx":
        'import classes from "./icon.module.css";\nexport const Icon = classes.logo;\n',
      "src/icon.module.css": ".logo { border-radius: 40px; }\n",
      // Never crawled: native projects and dependencies.
      "ios/App/thing.web.ts": "export {};\n",
      "node_modules/pkg/x.web.js": "export {};\n",
    });
    const paths = await resolveProject(dir);
    const entry = join(dir, "index.web.ts");
    const roots = await spaCssRoots(paths, entry);
    assertEquals(roots, [
      entry,
      join(dir, "src/app/_layout.tsx"),
      join(dir, "src/app/index.tsx"),
      join(dir, "src/icon.web.tsx"),
    ]);
    const css = await buildAppCss({
      projectDir: dir,
      configPath: paths.configPath,
      outDir: paths.outDir,
      minify: false,
      entryFiles: roots,
    });
    const text = await extractRouteCss(roots, css!);
    assertStringIncludes(text, "--font-mono");
    assertStringIncludes(text, "border-radius");

    // Outside React Native mode the entry alone is the crawl root.
    assertEquals(await spaCssRoots({ ...paths, config: { mode: "spa" } }, entry), [entry]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
