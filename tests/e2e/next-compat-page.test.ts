// e2e: the full next-compat PAGE pipeline — build a page that uses a real npm
// React library into server + client bundles, then SSR a full HTML document.
// Excluded from CI (needs npm + esbuild). Run:
//   deno test -A --unstable-kv tests/e2e/next-compat-page.test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildNextCompatPages,
  MOUNT_ID,
  renderNextCompatPage,
  routeToId,
} from "../../src/build/next-compat-build.ts";
import { buildCompatIndexPage, cacheNpm, writeCompatProject } from "./harness.ts";

// A page using a REAL npm Radix component (default export, denext page contract).
const RADIX_PAGE_SRC = `import { createElement as h } from "react";
import * as Label from "@radix-ui/react-label";
export default function Page(props) {
  return h("main", { "data-route": props?.params?.slug ?? "home" },
    h("h1", null, "Acme Site"),
    h(Label.Root, { htmlFor: "email" }, "Your email"),
    h("input", { id: "email", type: "email" }));
}
`;

// Root layout (denext page contract: { children, params }).
const ROOT_LAYOUT_SRC = `import { createElement as h } from "react";
export default function RootLayout(props) {
  return h("div", { className: "app-shell" }, h("header", null, "Acme Site"), props.children);
}
`;

const LABEL_PAGE_SRC = `import { createElement as h } from "react";
import * as Label from "@radix-ui/react-label";
export default function Page() {
  return h("main", null, h(Label.Root, { htmlFor: "e" }, "Email"));
}
`;

Deno.test("routeToId maps routes to safe ids", () => {
  assertEquals(routeToId("/"), "index");
  assertEquals(routeToId("/about"), "about");
  assertEquals(routeToId("/blog/[slug]"), "blog__slug_");
});

Deno.test("next-compat page pipeline: real npm Radix page → SSR document + client bundle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ncpage_" });
  try {
    await writeCompatProject(dir, { "@radix-ui/react-label": "2.1.8" });
    await Deno.writeTextFile(`${dir}/page.tsx`, RADIX_PAGE_SRC);

    const install = await cacheNpm(dir, ["npm:@radix-ui/react-label@2.1.8"]);
    assert(install.success, "npm install failed");

    const built = await buildCompatIndexPage(dir);
    assert(built.length === 1);

    const html = await renderNextCompatPage(
      built[0],
      { params: { slug: "home" } },
      "/_client/index.js",
    );

    // SSR document: real Radix Label + page content, mount node, hydration script.
    assertStringIncludes(html, "<!doctype html>");
    assertStringIncludes(html, `id="${MOUNT_ID}"`);
    assertStringIncludes(html, "Acme Site");
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

Deno.test("next-compat page pipeline: a react-dom/server importer resolves to single React", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ncserver_" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
    );
    // A page that imports from `react-dom/server` (the crash-class A1 case: without
    // the alias this would pull in a SECOND, real react-dom → two dispatchers).
    // It references the import so it stays in the graph (no tree-shake).
    await Deno.writeTextFile(
      `${dir}/page.tsx`,
      `import { createElement as h } from "react";
import { renderToReadableStream, version } from "react-dom/server";
export default function Page() {
  const has = typeof renderToReadableStream === "function" ? "yes" : "no";
  return h("main", null,
    h("h1", null, "Server APIs"),
    h("p", null, "stream:" + has + " v" + version));
}
`,
    );

    const built = await buildNextCompatPages({
      projectDir: dir,
      configPath: `${dir}/deno.json`,
      outDir: `${dir}/.denext`,
      pages: [{ routePath: "/", filePath: `${dir}/page.tsx` }],
    });
    assert(built.length === 1);

    const html = await renderNextCompatPage(built[0], {}, "/_client/index.js");
    assertStringIncludes(html, "Server APIs");
    assertStringIncludes(html, "stream:yes"); // the aliased fn resolved to denext's impl
    assertStringIncludes(html, "v19.2.0"); // denext's reported version

    const client = await Deno.readTextFile(built[0].clientBundle);
    assert(
      !/react\.development|react\.production|__SECRET_INTERNALS_DO_NOT_USE/.test(client),
      "importing react-dom/server must not pull in npm React",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("next-compat page pipeline: App Router layouts wrap the page", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_nclayout_" });
  try {
    await writeCompatProject(dir, { "@radix-ui/react-label": "2.1.8" });
    await Deno.writeTextFile(`${dir}/layout.tsx`, ROOT_LAYOUT_SRC);
    await Deno.writeTextFile(`${dir}/page.tsx`, LABEL_PAGE_SRC);
    const install = await cacheNpm(dir, ["npm:@radix-ui/react-label@2.1.8"]);
    assert(install.success, "npm install failed");

    const [built] = await buildCompatIndexPage(dir, [`${dir}/layout.tsx`]);
    const html = await renderNextCompatPage(built, {}, "/c.js");
    // Layout chrome wraps the page, which renders the real Radix Label.
    assertStringIncludes(html, 'class="app-shell"');
    assertStringIncludes(html, "Acme Site");
    assertStringIncludes(html, "<main>");
    assertStringIncludes(html, "<label");
    assertStringIncludes(html, "Email");
    // Order: header before the page's <main>.
    assert(html.indexOf("Acme Site") < html.indexOf("<main>"), "layout wraps page");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
