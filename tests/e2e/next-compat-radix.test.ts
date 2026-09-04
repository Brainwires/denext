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
  toImportUrl,
  withEsbuild,
} from "../../src/build/next-compat.ts";
import { cacheNpm, writeCompatProject } from "./harness.ts";

const frameworkRoot = fromFileUrl(new URL("../../", import.meta.url));

// A minimal project pulling the real Radix dialog from npm.
const RENDER_SRC = `import * as Dialog from "@radix-ui/react-dialog";
import { createElement as h } from "react";
import { renderToString } from "denext/ssr";
const tree = h(Dialog.Root, null,
  h(Dialog.Trigger, { className: "trigger" }, "Open dialog"),
  h(Dialog.Portal, null, h(Dialog.Content, null, h(Dialog.Title, null, "Hi"))));
export const html = await renderToString(tree);
`;

// A client hydration entry (denext/client + denext/jsx-runtime + the npm lib).
const CLIENT_SRC = `import { createRoot } from "denext/client";
import { h } from "denext/jsx-runtime";
import * as Dialog from "@radix-ui/react-dialog";
export function mount(el) {
  createRoot(el).render(h(Dialog.Root, null, h(Dialog.Trigger, null, "Open")));
}
`;

/** Prebuild the denext runtime, then bundle the SSR (deno) and client (browser) entries. */
function bundleServerAndClient(dir: string): Promise<void> {
  return withEsbuild(async () => {
    const runtimeDir = await prebuildDenextRuntime({
      outDir: `${dir}/.denext-runtime`,
      frameworkRoot,
      configPath: `${frameworkRoot}deno.json`,
    });
    const bundle = (entry: string, outfile: string, platform: "deno" | "browser") =>
      bundleNextCompat({
        entry: `${dir}/${entry}`,
        runtimeDir,
        outfile: `${dir}/${outfile}`,
        configPath: `${dir}/deno.json`,
        platform,
        denoLoader: false,
        absWorkingDir: dir,
      });
    await bundle("render.tsx", "out.js", "deno");
    await bundle("client.tsx", "out-client.js", "browser");
  });
}

Deno.test("next-compat: real npm @radix-ui/react-dialog SSRs on denext's single React", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nextcompat_" });
  try {
    await writeCompatProject(dir, { "@radix-ui/react-dialog": "1.1.15" });
    await Deno.writeTextFile(`${dir}/render.tsx`, RENDER_SRC);

    // Install the npm tree (radix + react-remove-scroll + aria-hidden + …).
    const install = await cacheNpm(dir, ["npm:@radix-ui/react-dialog@1.1.15"]);
    assert(install.success, "npm install failed");

    await Deno.writeTextFile(`${dir}/client.tsx`, CLIENT_SRC);
    await bundleServerAndClient(dir);

    const mod = await import(toImportUrl(`${dir}/out.js`)) as { html: string };
    // Real Radix ARIA, rendered by denext's SSR on a single React (no dispatcher error).
    assertStringIncludes(mod.html, "<button");
    assertStringIncludes(mod.html, 'aria-haspopup="dialog"');
    assertStringIncludes(mod.html, 'data-state="closed"');
    assertStringIncludes(mod.html, "Open dialog");
    assertStringIncludes(mod.html, 'class="trigger"');

    // The client bundle must be single-React (no npm React) and denext-based.
    const client = await Deno.readTextFile(`${dir}/out-client.js`);
    assert(
      !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(client),
      "client bundle must not contain npm React",
    );
    assert(
      client.includes("denext.fragment") || client.includes("react.forward_ref"),
      "client bundle must contain denext's runtime",
    );
    assertStringIncludes(client, "aria-haspopup", "client bundle includes real Radix Dialog code");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
