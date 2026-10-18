// Real-browser e2e for `defineLiveView` (denext/live): a server-held counter whose first view is
// in the page's HTML, mounted over the Live socket, with clicks going to the server and patches
// coming back. It runs twice: on the native App Router, and under `compatibilityMode: true` (the
// Next drop-in path), where `denext/live` is prebuilt into the compat runtime graph, so the app's
// `defineLiveView` and the server's Live hub load different copies of the live-view module and
// must still share one registry and one signing key (src/runtime/process-shared.ts). The page has
// no `"use client"` module of its own: the live view alone makes it a Flight route that ships the
// Live view client.
//
// The app is built and served by the CLI as a subprocess, like the other example e2es.
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  collectConsoleErrors,
  launchBrowser,
  pollFor,
  runDeno,
  startCliServer,
} from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const REPO_URL = toFileUrl(REPO).href;
const CLI = join(REPO, "cli.ts");

/** A one-page app with a live-view counter, native or under compatibilityMode. */
async function writeApp(dir: string, compat: boolean): Promise<void> {
  const files: Record<string, string> = {
    "deno.json": JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "denext",
          lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
        },
        imports: {
          "denext": `${REPO_URL}mod.ts`,
          "denext/jsx-runtime": `${REPO_URL}src/jsx/jsx-runtime.ts`,
          "denext/jsx-dev-runtime": `${REPO_URL}src/jsx/jsx-runtime.ts`,
          "denext/server": `${REPO_URL}src/server/mod.ts`,
          "denext/client": `${REPO_URL}src/client/mod.ts`,
          "denext/live": `${REPO_URL}src/live.ts`,
        },
      },
      null,
      2,
    ),
    "denext.config.ts": `export default { compatibilityMode: ${compat} };\n`,
    "app/layout.tsx": `import type { LayoutProps } from "denext/server";
export default function RootLayout({ children }: LayoutProps) {
  return <main>{children}</main>;
}
`,
    "app/page.tsx": `import { Counter } from "./counter.ts";
export default function Page() {
  return <section><h1>Live view</h1><Counter start={2} /></section>;
}
`,
    "app/counter.ts": `import { defineLiveView } from "denext/live";
import { h } from "denext/jsx-runtime";
export const Counter = defineLiveView<number, { type: "inc" }, { start: number }>({
  id: "counter",
  init: (props) => [props.start],
  update: (_msg, n) => [n + 1],
  view: (n, send) =>
    h("button", { type: "button", class: "inc", onClick: send({ type: "inc" }) }, String(n)),
});
`,
  };
  for (const [name, text] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), text);
  }
}

/** Build and serve the app, then click the counter through the Live socket. */
async function checkLiveView(compat: boolean): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-live-views-e2e-" }));
  try {
    await writeApp(dir, compat);
    const built = await runDeno(["run", "-A", CLI, "build", "."], dir, 300_000);
    assert(built.ok, "denext build failed:\n" + built.out);
    // Generous: a loaded machine loads the app slowly.
    const server = await startCliServer(dir, 180_000);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const errors = collectConsoleErrors(page);
      await page.goto(server.origin + "/", { waitUntil: "load" });
      const button = "document.querySelector('[data-dnx-view] .inc')";
      assertEquals(await page.evaluate(`${button}.textContent`), "2", "the server's first view");
      // Once mounted, a click goes to the server and its patch comes back. Click until the
      // socket is up (a click before the mount does nothing).
      await pollFor(page, `(() => { ${button}.click(); return ${button}.textContent !== '2'; })()`)
        .catch(async (err) => {
          const html = await page.evaluate("document.documentElement.outerHTML");
          throw new Error(
            `${err}\nconsole: ${JSON.stringify(errors)}\n${String(html).slice(0, 3000)}`,
          );
        });
      const after = Number(await page.evaluate(`${button}.textContent`));
      assert(after > 2, `the count went up (${after})`);
      assertEquals(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "e2e: a defineLiveView counter mounts over Live and takes clicks (native App Router)",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => checkLiveView(false));

Deno.test({
  name: "e2e: a defineLiveView counter mounts over Live and takes clicks (compatibilityMode)",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => checkLiveView(true));
