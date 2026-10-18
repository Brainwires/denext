// `denext create --template lustre`: the scaffold builds and serves. The build compiles the
// generated gleam/ project with denext's pinned Gleam (downloaded on first use) and fetches Lustre
// from Hex, so this needs the network the first time, like tests/e2e/lustre.e2e.test.ts. The page
// is then fetched from `denext start`: the island's markup, the custom element's declarative
// shadow root and the server view's first paint are all in the HTML.
//
// Opt-in: `deno task test:e2e`.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { scaffoldProject } from "../../src/build/scaffold.ts";
import { runDeno, startCliServer } from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const REPO_URL = toFileUrl(REPO).href;
const CLI = join(REPO, "cli.ts");

/** Point the app's `denext` imports at this checkout (the JSR release may not exist yet). */
async function pointAtThisCheckout(dir: string): Promise<void> {
  const path = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(path));
  for (const key of Object.keys(cfg.imports)) if (key.startsWith("denext")) delete cfg.imports[key];
  Object.assign(cfg.imports, {
    "denext": `${REPO_URL}mod.ts`,
    "denext/jsx-runtime": `${REPO_URL}src/jsx/jsx-runtime.ts`,
    "denext/jsx-dev-runtime": `${REPO_URL}src/jsx/jsx-runtime.ts`,
    "denext/server": `${REPO_URL}src/server/mod.ts`,
    "denext/client": `${REPO_URL}src/client/mod.ts`,
    "denext/testing": `${REPO_URL}src/testing/mod.ts`,
    "denext/gleam": `${REPO_URL}src/gleam.ts`,
  });
  delete cfg.lint; // a JSR specifier too, and nothing here lints
  await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2));
}

Deno.test({
  name: "e2e: denext create --template lustre scaffolds an app that builds and serves",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-create-lustre-" }));
  try {
    await scaffoldProject({ dir, template: "lustre", vscode: false });
    await pointAtThisCheckout(dir);
    const built = await runDeno(["run", "-A", CLI, "build", "."], dir, 300_000);
    assert(built.ok, "denext build failed:\n" + built.out);
    for (const kit of ["lustre.ts", "lustre-server.ts", "lustre-view.ts"]) {
      assert(await Deno.stat(join(dir, ".denext", kit)).then(() => true, () => false), kit);
    }
    const server = await startCliServer(dir, 180_000);
    try {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "data-denext-lustre"); // the island's root, Lustre's markup in it
      assertStringIncludes(html, '<span class="count">1</span>');
      assertStringIncludes(html, "<lustre-counter"); // the custom element
      assertStringIncludes(html, 'shadowrootmode="open"');
      assertStringIncludes(html, "data-dnx-lustre-view"); // the server component's root
      assertStringIncludes(html, '<span class="count">3</span>');
    } finally {
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
