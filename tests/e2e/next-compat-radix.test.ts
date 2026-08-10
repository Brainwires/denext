// e2e: prove a REAL npm React library (@radix-ui/react-dialog) runs on denext's
// single React via the next-compat esbuild bundler. Excluded from CI (tests/e2e/
// is ignored) because it installs npm packages and runs esbuild.
//
// Run manually:  deno test -A --unstable-kv tests/e2e/next-compat-radix.test.ts

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  bundleNextCompat,
  prebuildDenextRuntime,
  stopNextCompat,
  toImportUrl,
} from "../../src/build/next-compat.ts";

const frameworkRoot = fromFileUrl(new URL("../../", import.meta.url));

Deno.test("next-compat: real npm @radix-ui/react-dialog SSRs on denext's single React", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nextcompat_" });
  try {
    // A minimal project pulling the real Radix dialog from npm.
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
    );
    await Deno.writeTextFile(
      `${dir}/package.json`,
      JSON.stringify({ dependencies: { "@radix-ui/react-dialog": "1.1.15" } }),
    );
    await Deno.writeTextFile(
      `${dir}/render.tsx`,
      `import * as Dialog from "@radix-ui/react-dialog";
import { createElement as h } from "react";
import { renderToString } from "denext/ssr";
const tree = h(Dialog.Root, null,
  h(Dialog.Trigger, { className: "trigger" }, "Open dialog"),
  h(Dialog.Portal, null, h(Dialog.Content, null, h(Dialog.Title, null, "Hi"))));
export const html = await renderToString(tree);
`,
    );

    // Install the npm tree (radix + react-remove-scroll + aria-hidden + …).
    const install = await new Deno.Command(Deno.execPath(), {
      args: [
        "cache",
        "--no-lock",
        "--config",
        `${dir}/deno.json`,
        "npm:@radix-ui/react-dialog@1.1.15",
      ],
      cwd: dir,
    }).output();
    assert(install.success, "npm install failed");

    const runtimeDir = await prebuildDenextRuntime({
      outDir: `${dir}/.denext-runtime`,
      frameworkRoot,
      configPath: `${frameworkRoot}deno.json`,
    });
    await bundleNextCompat({
      entry: `${dir}/render.tsx`,
      runtimeDir,
      outfile: `${dir}/out.js`,
      configPath: `${dir}/deno.json`,
      platform: "deno",
      denoLoader: false,
      absWorkingDir: dir,
    });
    await stopNextCompat();

    const mod = await import(toImportUrl(`${dir}/out.js`)) as { html: string };
    // Real Radix ARIA, rendered by denext's SSR on a single React (no dispatcher error).
    assertStringIncludes(mod.html, "<button");
    assertStringIncludes(mod.html, 'aria-haspopup="dialog"');
    assertStringIncludes(mod.html, 'data-state="closed"');
    assertStringIncludes(mod.html, "Open dialog");
    assertStringIncludes(mod.html, 'class="trigger"');
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
