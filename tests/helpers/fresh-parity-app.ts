// A small Fresh 2 app (as `@fresh/init` lays one out) that uses what Fresh parity covers: a
// `<Partial>` region a `f-partial` button and an `f-client-nav` link update (`replace` and
// `append`), an island reading `import.meta.env` and Fresh's inlined `FRESH_PUBLIC_*`, a
// `main.ts` app wrapper, and a `.env` holding a public variable and a server secret. Migrated with
// `denext migrate`, it is built and served by tests/integration/fresh-parity-build.test.ts and
// driven in a browser by tests/e2e/fresh-partials.e2e.test.ts.

import { dirname, fromFileUrl, join } from "@std/path";
import { migrateProject } from "../../src/build/migrate.ts";

/** The secret the app's `.env` holds: it must never reach the browser. */
export const SECRET_VALUE = "s3cr3t-fresh-parity-value";
/** The public variable's value, which the island shows. */
export const PUBLIC_VALUE = "hello-fresh-public";

const REPO = fromFileUrl(new URL("../..", import.meta.url));

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify({
    tasks: { dev: "vite", build: "vite build", start: "deno serve -A _fresh/server.js" },
    imports: {
      "fresh": "jsr:@fresh/core@^2.3.3",
      "preact": "npm:preact@^10.29.1",
      "@preact/signals": "npm:@preact/signals@^2.9.0",
    },
    compilerOptions: {
      lib: ["dom", "dom.asynciterable", "dom.iterable", "deno.ns"],
      jsx: "precompile",
      jsxImportSource: "preact",
    },
  }),
  ".env": `FRESH_PUBLIC_GREETING=${PUBLIC_VALUE}\nPARITY_SECRET_TOKEN=${SECRET_VALUE}\n`,
  "main.ts": `import { App, staticFiles } from "fresh";
import { AppWrapper } from "./components/AppWrapper.tsx";
export const app = new App().use(staticFiles()).appWrapper(AppWrapper).fsRoutes();
`,
  "components/AppWrapper.tsx": `export function AppWrapper({ Component }) {
  return (
    <html>
      <head><title>parity</title></head>
      <body><div id="wrapper"><Component /></div></body>
    </html>
  );
}
`,
  "routes/index.tsx": `import { Partial } from "fresh/runtime";
import EnvIsland from "../islands/EnvIsland.tsx";
export default function Home() {
  return (
    <div f-client-nav>
      <button type="button" id="swap" f-partial="/parts/recipe">swap</button>
      <a id="more" href="/?page=2" f-partial="/parts/more">more</a>
      <Partial name="recipe"><p id="recipe">start</p></Partial>
      <ul><Partial name="list"><li>one</li></Partial></ul>
      <EnvIsland />
    </div>
  );
}
`,
  "routes/parts/recipe.tsx": `import { page } from "fresh";
import { Partial } from "fresh/runtime";
export const config = { skipAppWrapper: true };
export const handler = {
  GET(ctx) { return ctx.isPartial ? page() : ctx.redirect("/"); },
};
export default function Recipe() {
  return <Partial name="recipe"><p id="recipe">Lemonade</p></Partial>;
}
`,
  "routes/parts/more.tsx": `import { Partial } from "fresh/runtime";
export const config = { skipAppWrapper: true };
export default function More() {
  return <Partial name="list" mode="append" key="two"><li>two</li></Partial>;
}
`,
  "islands/EnvIsland.tsx": `import { useEffect, useState } from "preact/hooks";
export default function EnvIsland() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const greeting = Deno.env.get("FRESH_PUBLIC_GREETING");
  const secret = import.meta.env.PARITY_SECRET_TOKEN;
  return (
    <p id="env" class={ready ? "ready" : ""}>
      {greeting} {import.meta.env.FRESH_PUBLIC_GREETING} {String(secret)}
    </p>
  );
}
`,
};

/**
 * Write the app into `dir` and migrate it (`denext migrate`, the framework from this checkout).
 *
 * @param dir An empty directory.
 */
export async function writeFreshParityApp(dir: string): Promise<void> {
  for (const [rel, body] of Object.entries(FILES)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
}
