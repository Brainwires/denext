// Migration bed: Preact's own starter — create-preact's Vite template with its router option
// (`templates/base` + `templates/config/router` in preactjs/create-preact): `@preact/preset-vite`,
// preact-iso's `<LocationProvider>` / `<Router>` / `<Route>` / `useLocation`, an SVG imported as
// an asset, CSS imports, and `render()` into `#app`. `denext migrate` takes the SPA path with the
// Preact layer (preact → denext, preact-iso → denext/preact-iso), then the app is built, served,
// its shell checked with JS off, and in headless Chromium it renders and a header link navigates
// on the client. The bed adds a preact-iso `lazy()` route whose page holds a `useErrorBoundary`
// component catching a child's render error, and an `options.vnode` hook that marks `<main>` — so
// the click loads a code-split route through the Router, the hook boundary renders its error UI,
// and Preact's options hook ran on the app's own JSX.
//
// Pin: 3903ab1 (2026-09-30). create-preact assembles a project from its templates at run time
// (`templates/base`, then `templates/config/router` into `src/`, plus `preact-iso` as a
// dependency); the install and `prepare` do the same steps.
// NETWORK-REQUIRED (GitHub fetch + npm install): `deno task test:migration-bed`.

import { copy } from "@std/fs";
import { join } from "@std/path";
import { type Bed, runBed } from "./_bed.ts";

const PREACT_VITE: Bed = {
  name: "preact-vite",
  repo: "https://github.com/preactjs/create-preact.git",
  sha: "3903ab1d48abf04492d6b8624a0e6f6e93f5c516",
  subdir: "templates/base",
  install: [
    ["npm", "pkg", "set", "dependencies.preact-iso=^2.12.2"],
    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
  ],
  // The router option: create-preact copies `templates/config/router` over `src/`.
  prepare: async (app) => {
    await copy(join(app, "..", "config", "router"), join(app, "src"), { overwrite: true });
    await Deno.rename(join(app, "_gitignore"), join(app, ".gitignore"));
    await addPreactParityScenario(join(app, "src"));
  },
  kind: "preact",
  routes: [
    // The SPA shell (what a browser without JS gets): the template's title and mount point.
    { path: "/", contains: "<title>Vite + Preact</title>" },
    { path: "/", contains: '<div id="app">' },
    // Every path serves the shell; preact-iso routes it in the browser.
    { path: "/404", contains: '<div id="app">' },
    // A public file.
    { path: "/vite.svg", contains: "<svg" },
  ],
  browser: {
    path: "/",
    hydrated: 'document.querySelector("h1")?.textContent.includes("Get Started") === true',
    interact: {
      click: 'header a[href="/lazy"]',
      until:
        'location.pathname === "/lazy" && document.body.textContent.includes("lazy page") && ' +
        'document.body.textContent.includes("caught: broken child") && ' +
        'document.querySelector("main[data-options-vnode]") !== null',
    },
  },
};

/**
 * The Preact-parity scenario added to the template: a `/lazy` route loaded with preact-iso's
 * `lazy()`, a page whose `useErrorBoundary` component catches its child's render error, an
 * `options.vnode` hook marking `<main>`, and a header link to the route.
 */
async function addPreactParityScenario(src: string): Promise<void> {
  const index = join(src, "index.jsx");
  let entry = await Deno.readTextFile(index);
  entry = entry
    .replace(
      "import { render } from 'preact';",
      "import { options, render } from 'preact';\n" +
        "options.vnode = (v) => { if (v.type === 'main') v.props['data-options-vnode'] = ''; };",
    )
    .replace(
      "import { LocationProvider, Router, Route } from 'preact-iso';",
      "import { LocationProvider, Router, Route, lazy } from 'preact-iso';\n" +
        "const LazyPage = lazy(() => import('./pages/Lazy.jsx'));",
    )
    .replace(
      '<Route path="/" component={Home} />',
      '<Route path="/" component={Home} />\n\t\t\t\t\t<Route path="/lazy" component={LazyPage} />',
    );
  await Deno.writeTextFile(index, entry);
  await Deno.writeTextFile(
    join(src, "pages", "Lazy.jsx"),
    `import { useErrorBoundary } from 'preact/hooks';

function Broken() {
\tthrow new Error('broken child');
}

function Guard({ children }) {
\tconst [error] = useErrorBoundary();
\treturn error ? <p>caught: {error.message}</p> : children;
}

export default function Lazy() {
\treturn (
\t\t<section>
\t\t\t<h2>lazy page</h2>
\t\t\t<Guard><Broken /></Guard>
\t\t</section>
\t);
}
`,
  );
  const header = join(src, "components", "Header.jsx");
  await Deno.writeTextFile(
    header,
    (await Deno.readTextFile(header)).replace(
      '<a href="/404"',
      '<a href="/lazy">Lazy</a>\n\t\t\t\t<a href="/404"',
    ),
  );
}

Deno.test({
  name: "migration bed: create-preact's Vite + preact-iso app migrates, builds and routes",
}, (t) => runBed(t, PREACT_VITE));
