// `denext export` writes `404.html`, as Next's `output: "export"` does: the root not-found UI
// (`app/not-found.tsx`, else the default 404 UI) inside the root layout, with the root layout's
// and the not-found's stylesheets; with `trailingSlash` the same document is also written to
// `404/index.html`. Static hosts (GitHub Pages, Netlify, Cloudflare Pages) serve that file for
// a URL with no file of its own.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { boundedOutput } from "../helpers/bounded-command.ts";
import { CHILD_DEADLINE_MS } from "../helpers/isolated.ts";

const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

/** `denext export` the app in `dir` as the CLI runs it (its loader takes stylesheet imports). */
async function exportApp(dir: string): Promise<{ outDir: string }> {
  const out = await boundedOutput(Deno.execPath(), {
    args: ["run", "-A", CLI, "export", dir],
    cwd: dir,
    timeoutMs: CHILD_DEADLINE_MS,
  });
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, log);
  return { outDir: join(dir, "out") };
}

const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

/** A native app with a root layout (and its stylesheet) and a home page. */
async function writeFixture(dir: string, config = "export default {};\n"): Promise<void> {
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
  await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(join(dir, "app", "globals.css"), ".nf-layout{color:rebeccapurple}\n");
  await Deno.writeTextFile(
    join(dir, "app", "layout.tsx"),
    `import "./globals.css";
export const metadata = { description: "NF_SITE" };
export default function RootLayout({ children }: { children: unknown }) {
  return <html><body><header>NF_LAYOUT</header>{children}</body></html>;
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    `export default function Page() { return <main>NF_HOME</main>; }\n`,
  );
}

/** Add an `app/not-found.tsx` with its own stylesheet. */
async function addNotFound(dir: string): Promise<void> {
  await Deno.writeTextFile(join(dir, "app", "not-found.css"), ".nf-own{color:tomato}\n");
  await Deno.writeTextFile(
    join(dir, "app", "not-found.tsx"),
    `import "./not-found.css";
export default function NotFound() {
  return <section><h2>NF_CUSTOM</h2><a href="/">home</a></section>;
}
`,
  );
}

Deno.test({
  name: "export: app/not-found.tsx is pre-rendered to 404.html inside the root layout",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_nf_" });
  try {
    await writeFixture(dir);
    await addNotFound(dir);
    const result = await exportApp(dir);
    const html = await Deno.readTextFile(join(result.outDir, "404.html"));
    assert(html.startsWith("<!DOCTYPE html>"), "a full document");
    assertStringIncludes(html, "NF_LAYOUT", "rendered inside the root layout");
    assertStringIncludes(html, "<h2>NF_CUSTOM</h2>");
    assertStringIncludes(html, "<title>404 — Not Found</title>");
    assertStringIncludes(html, "NF_SITE", "the root layout's metadata applies");
    assert(!html.includes("NF_HOME"), "not the home page");
    // No hydration, as the document the server answers an unmatched URL with.
    assert(!html.includes('type="module"'), "the 404 document ships no client entry");
    // The root layout's and the not-found's styles, in one stylesheet.
    const href = "/_denext/client/_not-found.css";
    assertStringIncludes(html, `href="${href}"`);
    const css = await Deno.readTextFile(join(result.outDir, href.slice(1)));
    assertStringIncludes(css, "nf-layout");
    assertStringIncludes(css, "nf-own");
    // No trailingSlash: no 404/index.html (Next writes it only then).
    assertEquals(await exists(join(result.outDir, "404", "index.html")), false);
    // The home page is unaffected.
    assertStringIncludes(await Deno.readTextFile(join(result.outDir, "index.html")), "NF_HOME");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "export: without app/not-found.tsx, 404.html is the default 404 UI in the root layout",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_nf_default_" });
  try {
    await writeFixture(dir);
    const result = await exportApp(dir);
    const html = await Deno.readTextFile(join(result.outDir, "404.html"));
    assertStringIncludes(html, "NF_LAYOUT");
    assertStringIncludes(html, "<h1>404</h1>");
    assertStringIncludes(html, "This page could not be found.");
    assertStringIncludes(html, "<title>404 — Not Found</title>");
    // The root layout's stylesheet still applies.
    assertStringIncludes(html, 'href="/_denext/client/_not-found.css"');
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "export: trailingSlash also writes 404/index.html; basePath prefixes the stylesheet",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_export_nf_slash_" });
  try {
    await writeFixture(dir, `export default { trailingSlash: true, basePath: "/docs" };\n`);
    await addNotFound(dir);
    const result = await exportApp(dir);
    const flat = await Deno.readTextFile(join(result.outDir, "404.html"));
    const nested = await Deno.readTextFile(join(result.outDir, "404", "index.html"));
    assertEquals(nested, flat, "the same document at both paths");
    assertStringIncludes(flat, "NF_CUSTOM");
    assertStringIncludes(flat, 'href="/docs/_denext/client/_not-found.css"');
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
