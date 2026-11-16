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
export function writeFreshParityApp(dir: string): Promise<void> {
  return writeAndMigrate(dir, FILES);
}

/** Write `files` into `dir` and migrate the Fresh app they make (the framework from here). */
async function writeAndMigrate(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  await migrateProject(dir, { denextLocalPath: REPO, from: "fresh" });
}

/**
 * A second Fresh 2 app for partial navigation between two pages: `/` and `/b` render the same
 * shell (an `f-client-nav` + `f-view-transition` root, a counter island, two links) around a
 * `<Partial name="main">`, and each sets its own `<Head>`: a title, a `description` meta and a
 * page stylesheet. Driven in a browser by tests/e2e/fresh-partials.e2e.test.ts.
 */
const NAV_FILES: Record<string, string> = {
  "deno.json": FILES["deno.json"],
  "main.ts": `import { App, staticFiles } from "fresh";
import { AppWrapper } from "./components/AppWrapper.tsx";
export const app = new App().use(staticFiles()).appWrapper(AppWrapper).fsRoutes();
`,
  "components/AppWrapper.tsx": `export function AppWrapper({ Component }) {
  return (
    <html>
      <head><meta charset="utf-8" /></head>
      <body><Component /></body>
    </html>
  );
}
`,
  "components/Shell.tsx": `import { Head, Partial } from "fresh/runtime";
import Counter from "../islands/Counter.tsx";
export function Shell({ name, children }) {
  return (
    <div f-client-nav f-view-transition>
      <Head>
        <title>{"Page " + name}</title>
        <meta name="description" content={"about " + name} />
        <link rel="stylesheet" href={"/" + name + ".css"} />
      </Head>
      <nav><a id="to-a" href="/">a</a> <a id="to-b" href="/b">b</a></nav>
      <Counter />
      <Partial name="main">{children}</Partial>
    </div>
  );
}
`,
  "routes/index.tsx": `import { Shell } from "../components/Shell.tsx";
export default function A() {
  return <Shell name="a"><p id="content">content a</p></Shell>;
}
`,
  "routes/b.tsx": `import { Shell } from "../components/Shell.tsx";
export default function B() {
  return <Shell name="b"><p id="content">content b</p></Shell>;
}
`,
  "islands/Counter.tsx": `import { useEffect, useState } from "preact/hooks";
export default function Counter() {
  const [n, setN] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <button type="button" id="inc" class={ready ? "ready" : ""} onClick={() => setN(n + 1)}>
      {String(n)}
    </button>
  );
}
`,
  "static/a.css": `#content { color: rgb(1, 2, 3); }\n`,
  "static/b.css": `#content { letter-spacing: 1px; }\n`,
};

/**
 * Write the two-page navigation app into `dir` and migrate it (`denext migrate`).
 *
 * @param dir An empty directory.
 */
export function writeFreshNavApp(dir: string): Promise<void> {
  return writeAndMigrate(dir, NAV_FILES);
}
