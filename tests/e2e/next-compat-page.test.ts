// e2e: the full next-compat PAGE pipeline — build a page that uses a real npm
// React library into server + client bundles, then SSR a full HTML document.
// Excluded from CI (needs npm + esbuild). Run:
//   deno test -A --unstable-kv tests/e2e/next-compat-page.test.ts

import { assert, assertStringIncludes } from "@std/assert";
import {
  buildNextCompatPages,
  MOUNT_ID,
  renderNextCompatPage,
} from "../../src/build/next-compat-build.ts";

Deno.test("next-compat page pipeline: real npm Radix page → SSR document + client bundle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ncpage_" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
    );
    await Deno.writeTextFile(
      `${dir}/package.json`,
      JSON.stringify({ dependencies: { "@radix-ui/react-label": "2.1.8" } }),
    );
    // A page using a REAL npm Radix component (default export, denext page contract).
    await Deno.writeTextFile(
      `${dir}/page.tsx`,
      `import { createElement as h } from "react";
import * as Label from "@radix-ui/react-label";
export default function Page(props) {
  return h("main", { "data-route": props?.params?.slug ?? "home" },
    h("h1", null, "PDQ Roofing"),
    h(Label.Root, { htmlFor: "email" }, "Your email"),
    h("input", { id: "email", type: "email" }));
}
`,
    );

    const install = await new Deno.Command(Deno.execPath(), {
      args: [
        "cache",
        "--no-lock",
        "--config",
        `${dir}/deno.json`,
        "npm:@radix-ui/react-label@2.1.8",
      ],
      cwd: dir,
    }).output();
    assert(install.success, "npm install failed");

    const built = await buildNextCompatPages({
      projectDir: dir,
      configPath: `${dir}/deno.json`,
      outDir: `${dir}/.denext`,
      pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
    });
    assert(built.length === 1);

    const html = await renderNextCompatPage(
      built[0],
      { params: { slug: "home" } },
      "/_client/index.js",
    );

    // SSR document: real Radix Label + page content, mount node, hydration script.
    assertStringIncludes(html, "<!doctype html>");
    assertStringIncludes(html, `id="${MOUNT_ID}"`);
    assertStringIncludes(html, "PDQ Roofing");
    assertStringIncludes(html, "Your email"); // Radix Label rendered
    assertStringIncludes(html, "<label");
    assertStringIncludes(html, 'data-route="home"'); // props threaded to the page
    assertStringIncludes(html, "__DENEXT_PROPS__"); // hydration props embedded
    assertStringIncludes(html, '<script type="module" src="/_client/index.js">');

    // Client bundle is single-React.
    const client = await Deno.readTextFile(built[0].clientBundle);
    assert(
      !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(client),
      "client bundle must not contain npm React",
    );
    assert(
      client.includes("denext.fragment") || client.includes("react.forward_ref"),
      "client bundle must contain denext's runtime",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
