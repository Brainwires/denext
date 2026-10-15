// `global-error.tsx` hydration on the next-compat build path and on `denext export` (native and
// next-compat). The native `denext build` and `denext dev` have always emitted the global-error
// entry; these two paths emitted none, so the global-error document stayed server-rendered only
// and its `reset` was inert. Now:
// - a next-compat `denext build` bundles the entry (react→denext rewritten, like its routes) into
//   `client/__denext_global_error__.js`, so `denext start` wires it into the global-error 500 document;
// - `denext export` bundles the same entry and pre-renders the global-error document to
//   `500.html`, wired for hydration (a static host's error page).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { staticExport } from "../../src/build/export.ts";
import { stopNextCompat } from "../../src/build/next-compat.ts";
import { serveEphemeral } from "../../src/build/prod-server.ts";
import { GLOBAL_ERROR_BUNDLE_FILE } from "../../src/build/build-pipeline/context.ts";

const GE_ENTRY = `/_denext/client/${GLOBAL_ERROR_BUNDLE_FILE}`;

/** A next-compat app: a page, a page that always throws, and a react-importing global-error. */
async function writeCompatFixture(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ nodeModulesDir: "auto", imports: {} }),
  );
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    "export default { compatibilityMode: true };\n",
  );
  await Deno.mkdir(join(dir, "app", "boom"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app", "layout.tsx"),
    `import { createElement as h } from "react";
export default function RootLayout({ children }) {
  return h("html", null, h("body", null, children));
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    `import { createElement as h } from "react";
export default function Page() {
  return h("main", null, "GE_HOME");
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "boom", "page.tsx"),
    `export const dynamic = "force-dynamic";
export default function Boom() {
  throw new Error("GE_SECRET_DETAIL");
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "global-error.tsx"),
    `"use client";
import { createElement as h, useState } from "react";
export default function GlobalError({ error, reset }) {
  const [n, setN] = useState(0);
  return h("html", null, h("body", null,
    h("h2", null, "GE_COMPAT_UI:" + error.message),
    h("button", { onClick: () => { setN(n + 1); reset(); } }, "GE_RETRY:" + n),
  ));
}
`,
  );
}

/** A native (denext-importing) app with a global-error.tsx. */
async function writeNativeFixture(dir: string): Promise<void> {
  const root = new URL("../../", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${root}mod.ts`,
        "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
        "denext/server": `${root}src/server/mod.ts`,
        "denext/client": `${root}src/client/mod.ts`,
      },
    }),
  );
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app", "layout.tsx"),
    `export default function RootLayout({ children }: { children: unknown }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    `export default function Page() { return <main>GE_NATIVE_HOME</main>; }\n`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "global-error.tsx"),
    `"use client";
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return <html><body><h2>{"GE_NATIVE_UI:" + error.message}</h2>
    <button type="button" onClick={() => reset()}>Try again</button></body></html>;
}
`,
  );
}

/** Assert `html` is a document-owning global-error page wired to hydrate from `entry`. */
function assertHydratedGlobalError(html: string, marker: string, entry = GE_ENTRY): void {
  assert(html.startsWith("<!DOCTYPE html>"), "global-error owns the document");
  assertStringIncludes(html, marker);
  assertStringIncludes(html, `id="__denext_ge_data"`);
  assertStringIncludes(html, `<script type="module" src="${entry}"></script>`);
}

Deno.test({
  name: "next-compat build: global-error.tsx gets a hydration entry the 500 document loads",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ge_compat_build_" });
  try {
    await writeCompatFixture(dir);
    await build(dir);
    const entry = await Deno.readTextFile(join(dir, ".denext", "client", GLOBAL_ERROR_BUNDLE_FILE));
    // The entry rebuilds the error from the server's data island and hydrates the document.
    assertStringIncludes(entry, "__denext_ge_data");
    const server = await serveEphemeral(dir);
    try {
      const res = await fetch(`${server.origin}/boom`);
      assertEquals(res.status, 500);
      const html = await res.text();
      // Production redaction holds: the client sees the generic message, never the detail.
      assertHydratedGlobalError(html, "GE_COMPAT_UI:Internal Server Error");
      assert(!html.includes("GE_SECRET_DETAIL"), "the real error leaked");
      const js = await fetch(`${server.origin}${GE_ENTRY}`);
      assertEquals(js.status, 200);
      assertStringIncludes(await js.text(), "__denext_ge_data");
    } finally {
      await server.close();
    }
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "export (next-compat): global-error.tsx is pre-rendered to 500.html and hydrates",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ge_compat_export_" });
  try {
    await writeCompatFixture(dir);
    const result = await staticExport(dir);
    assert(result.skipped.includes("/boom"), "the force-dynamic route is skipped");
    const html = await Deno.readTextFile(join(result.outDir, "500.html"));
    assertHydratedGlobalError(html, "GE_COMPAT_UI:Internal Server Error");
    assertStringIncludes(html, "GE_RETRY:0");
    const entry = await Deno.readTextFile(
      join(result.outDir, "_denext", "client", GLOBAL_ERROR_BUNDLE_FILE),
    );
    assertStringIncludes(entry, "__denext_ge_data");
    // A regular page is unaffected (its own document, no global-error wiring).
    const index = await Deno.readTextFile(join(result.outDir, "index.html"));
    assertStringIncludes(index, "GE_HOME");
    assert(!index.includes("__denext_ge_data"));
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "export (native): global-error.tsx is pre-rendered to 500.html and hydrates",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ge_native_export_" });
  try {
    await writeNativeFixture(dir);
    const result = await staticExport(dir);
    const html = await Deno.readTextFile(join(result.outDir, "500.html"));
    assertHydratedGlobalError(html, "GE_NATIVE_UI:Internal Server Error");
    const entry = await Deno.readTextFile(
      join(result.outDir, "_denext", "client", GLOBAL_ERROR_BUNDLE_FILE),
    );
    assertStringIncludes(entry, "__denext_ge_data");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "export: an app without global-error.tsx writes no 500.html and no entry",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ge_none_export_" });
  try {
    await writeNativeFixture(dir);
    await Deno.remove(join(dir, "app", "global-error.tsx"));
    const result = await staticExport(dir);
    const exists = (p: string) => Deno.stat(p).then(() => true, () => false);
    assertEquals(await exists(join(result.outDir, "500.html")), false);
    assertEquals(
      await exists(join(result.outDir, "_denext", "client", GLOBAL_ERROR_BUNDLE_FILE)),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "native build: a route at /global-error keeps its own bundle beside the global-error entry",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_ge_route_collision_" });
  try {
    await writeNativeFixture(dir);
    // A route whose id is `global-error` — the name the global-error entry used to be written as.
    await Deno.mkdir(join(dir, "app", "global-error"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "app", "global-error", "page.tsx"),
      // A page that calls a hook itself is a whole-route client bundle (`<routeId>.js`).
      `import { useState } from "denext";
export default function Page() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{"GE_ROUTE_PAGE:" + n}</button>;
}
`,
    );
    await build(dir);
    const client = join(dir, ".denext", "client");
    const route = await Deno.readTextFile(join(client, "global-error.js"));
    assertStringIncludes(route, "GE_ROUTE_PAGE", "the route's bundle was overwritten");
    assert(!route.includes("GE_NATIVE_UI"), "the route's file holds the global-error entry");
    const entry = await Deno.readTextFile(join(client, GLOBAL_ERROR_BUNDLE_FILE));
    assertStringIncludes(entry, "GE_NATIVE_UI");
    const server = await serveEphemeral(dir);
    try {
      const html = await (await fetch(`${server.origin}/global-error`)).text();
      assertStringIncludes(html, "GE_ROUTE_PAGE:0");
      assertStringIncludes(html, "/_denext/client/global-error.js");
      const js = await (await fetch(`${server.origin}/_denext/client/global-error.js`)).text();
      assertStringIncludes(js, "GE_ROUTE_PAGE");
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
