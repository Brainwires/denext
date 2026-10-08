// `@denext/react-router` end to end, in process: a React Router v7 framework-mode app
// (root.tsx with a `Layout` export, `app/routes.ts` config routing with a pathless layout,
// a prefix, an index, a dynamic route with a loader + action, a resource route, a route whose
// loader throws) → `applyPlugins` → `scanRoutes` (the synthesizer generates the wrappers into
// .denext/react-router and adds the routes) → `createApp` renders them: loader data reaches
// the component as PROPS and through `useLoaderData`, the action answers a POST, the resource
// route answers GET, the thrown Response reaches the route's ErrorBoundary with its status.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { reactRouter } from "../packages/react-router/mod.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createApp } from "../src/server/app.ts";
import { defaultLoader } from "../src/server/mod.ts";

const DSL = new URL("../packages/react-router/routes.ts", import.meta.url).href;

async function writeApp(root: string): Promise<void> {
  const app = join(root, "app");
  const w = async (rel: string, code: string) => {
    const path = join(app, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, code);
  };
  await w(
    "root.tsx",
    `import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "react-router";
export const links = () => [{ rel: "stylesheet", href: "/app.css" }];
export function Layout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <head><Meta /><Links /></head>
      <body data-app="rr7">{children}<ScrollRestoration /><Scripts /></body>
    </html>
  );
}
export default function App() {
  return <Outlet />;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <main id="root-error">{isRouteErrorResponse(error) ? String(error.status) : "root boom"}</main>;
}
`,
  );
  await w(
    "routes.ts",
    `import { index, layout, prefix, route } from ${JSON.stringify(DSL)};
export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  layout("routes/shell.tsx", [
    ...prefix("teams", [index("routes/teams/list.tsx"), route(":id", "routes/teams/team.tsx")]),
  ]),
  route("api/health", "routes/api/health.ts"),
  route("boom", "routes/boom.tsx"),
];
`,
  );
  await w(
    "routes/home.tsx",
    `import { useLoaderData } from "react-router";
export async function loader() {
  return { greeting: "hello" };
}
export default function Home({ loaderData }: { loaderData: { greeting: string } }) {
  const viaHook = useLoaderData<typeof loader>();
  return <h1 id="home">{loaderData.greeting}/{viaHook.greeting}</h1>;
}
`,
  );
  await w(
    "routes/about.tsx",
    `export default function About() {\n  return <p id="about">about</p>;\n}\n`,
  );
  await w(
    "routes/shell.tsx",
    `import { Outlet } from "react-router";
export default function Shell() {
  return <section><nav id="shell">shell</nav><Outlet /></section>;
}
`,
  );
  await w(
    "routes/teams/list.tsx",
    `export default function Teams() {\n  return <ul id="teams"><li>a</li></ul>;\n}\n`,
  );
  await w(
    "routes/teams/team.tsx",
    `import { Form } from "react-router";
export function loader({ params }: { params: { id: string } }) {
  return { id: params.id };
}
export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  return { renamed: String(form.get("name")) };
}
export default function Team({ loaderData, params }: { loaderData: { id: string }; params: { id: string } }) {
  return (
    <article id="team">team {loaderData.id} ({params.id})<Form method="post"><input name="name" /></Form></article>
  );
}
`,
  );
  await w(
    "routes/api/health.ts",
    `export function loader() {\n  return Response.json({ ok: true });\n}\n`,
  );
  await w(
    "routes/boom.tsx",
    `import { isRouteErrorResponse, useRouteError } from "react-router";
export function loader() {
  throw new Response("teapot", { status: 418 });
}
export default function Boom() {
  return <p>never</p>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  return <p id="boom">{isRouteErrorResponse(error) ? \`caught \${error.status}\` : "other"}</p>;
}
`,
  );
}

Deno.test("react-router plugin: routes.ts → generated wrappers → the core App Router serves the RR7 app", async () => {
  resetPlugins();
  // Inside the repo: the generated wrappers import `denext/remix/server`, which a real app
  // resolves through ITS deno.json; here the workspace import map has to apply.
  const tmpBase = fromFileUrl(new URL("./.tmp/", import.meta.url));
  await Deno.mkdir(tmpBase, { recursive: true });
  const root = await Deno.makeTempDir({ dir: tmpBase, prefix: "rr7_" });
  try {
    await writeApp(root);
    await applyPlugins({
      projectRoot: root,
      appDir: join(root, "app"),
      config: { plugins: [reactRouter()] },
      mode: "build",
      load: defaultLoader,
    });
    const manifest = await scanRoutes(join(root, "app"));
    const pages = manifest.pages.map((p) => p.routePath).sort();
    assertEquals(pages, ["/", "/about", "/boom", "/teams", "/teams/[id]"]);
    assertEquals(manifest.api.map((a) => a.routePath).sort(), ["/api/health", "/teams/[id]"]);
    assert(
      manifest.rootLayout?.endsWith(join(".denext", "react-router", "root", "layout.tsx")),
      manifest.rootLayout ?? "",
    );
    const team = manifest.pages.find((p) => p.routePath === "/teams/[id]")!;
    assertEquals(team.layoutChain.length, 2, "root + the pathless shell layout");
    assertEquals(team.layoutDepths, [0, 0]);
    assert(
      team.filePath.includes(join(".denext", "react-router", "routes__teams__team", "page.tsx")),
    );
    const boom = manifest.pages.find((p) => p.routePath === "/boom")!;
    assert(
      boom.error?.endsWith(join("routes__boom", "error.tsx")),
      "the route's ErrorBoundary is its error.tsx",
    );

    const app = createApp({ getManifest: () => manifest, load: defaultLoader });
    const home = await app(new Request("http://localhost/"));
    const homeHtml = await home.text();
    assertEquals(home.status, 200);
    assertStringIncludes(
      homeHtml,
      'data-app="rr7"',
      "the root Layout export renders the document body",
    );
    assertStringIncludes(
      homeHtml,
      '<h1 id="home">hello/hello</h1>',
      "loader data as props AND via useLoaderData",
    );
    assertStringIncludes(homeHtml, 'rel="stylesheet" href="/app.css"', "root links() → head");

    const teamHtml = await (await app(new Request("http://localhost/teams/42"))).text();
    assertStringIncludes(teamHtml, '<nav id="shell">shell</nav>', "the pathless layout wraps");
    assertStringIncludes(teamHtml, "team 42 (42)");
    assertStringIncludes(
      await (await app(new Request("http://localhost/teams"))).text(),
      '<ul id="teams">',
    );

    const form = new FormData();
    form.set("name", "Deno");
    const posted = await app(
      new Request("http://localhost/teams/42", { method: "POST", body: form }),
    );
    assertEquals(posted.status, 200);
    assertEquals(
      await posted.json(),
      { renamed: "Deno" },
      "the page's action answers a plain POST",
    );

    const health = await app(new Request("http://localhost/api/health"));
    assertEquals(await health.json(), { ok: true }, "a resource route's loader answers GET");

    const boomRes = await app(new Request("http://localhost/boom"));
    assertEquals(boomRes.status, 418, "a thrown Response sets the document status");
    assertStringIncludes(
      await boomRes.text(),
      "caught 418",
      "…and reaches the route's ErrorBoundary",
    );

    const missing = await app(new Request("http://localhost/nope"));
    assertEquals(missing.status, 404);
  } finally {
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
});

/** Write `files` (app-relative) under `<root>/app`, plus `react-router.config.ts` when given. */
async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, code] of Object.entries(files)) {
    const path = rel === "react-router.config.ts" ? join(root, rel) : join(root, "app", rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, code);
  }
}

/** Build an app from `files` through the plugin and hand its handler + manifest to `run`. */
async function withRrApp(
  files: Record<string, string>,
  run: (
    app: (req: Request) => Promise<Response>,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  resetPlugins();
  const tmpBase = fromFileUrl(new URL("./.tmp/", import.meta.url));
  await Deno.mkdir(tmpBase, { recursive: true });
  const root = await Deno.makeTempDir({ dir: tmpBase, prefix: "rr7c_" });
  try {
    await writeFiles(root, files);
    await applyPlugins({
      projectRoot: root,
      appDir: join(root, "app"),
      config: { plugins: [reactRouter()] },
      mode: "build",
      load: defaultLoader,
    });
    const manifest = await scanRoutes(join(root, "app"));
    const app = createApp({ getManifest: () => manifest, load: defaultLoader });
    await run(app, root);
  } finally {
    resetPlugins();
    await Deno.remove(root, { recursive: true });
  }
}

const CLIENT_ROOT = `import { Outlet, useRouteError } from "react-router";
export function Layout({ children }: { children: unknown }) {
  return <html lang="en"><head /><body data-app="rr7c">{children}</body></html>;
}
export default function App() {
  return <Outlet />;
}
export function ErrorBoundary() {
  return <p id="root-error">{String(useRouteError())}</p>;
}
`;

Deno.test("react-router plugin: clientLoader / clientAction / HydrateFallback reach the boundary", async () => {
  await withRrApp({
    "root.tsx": CLIENT_ROOT,
    "routes.ts": `import { route } from ${JSON.stringify(DSL)};
export default [
  route("hydrating", "routes/hydrating.tsx"),
  route("lazy", "routes/lazy.tsx"),
  route("client-only", "routes/client-only.tsx"),
];
`,
    "routes/hydrating.tsx": `export function loader() {
  return { from: "server" };
}
export async function clientLoader({ serverLoader }: { serverLoader: () => Promise<{ from: string }> }) {
  return { from: (await serverLoader()).from + "+client" };
}
clientLoader.hydrate = true as const;
export function HydrateFallback() {
  return <p id="fallback">loading in the browser</p>;
}
export default function Hydrating({ loaderData }: { loaderData: { from: string } }) {
  return <p id="hydrating">{loaderData.from}</p>;
}
`,
    "routes/lazy.tsx": `export function loader() {
  return { from: "server" };
}
export async function clientLoader() {
  return { from: "client" };
}
export async function clientAction({ serverAction }: { serverAction: () => Promise<unknown> }) {
  return await serverAction();
}
export function action() {
  return { ok: true };
}
export default function Lazy({ loaderData }: { loaderData: { from: string } }) {
  return <p id="lazy">{loaderData.from}</p>;
}
`,
    "routes/client-only.tsx": `export async function clientLoader() {
  return { from: "client" };
}
export default function ClientOnly({ loaderData }: { loaderData: { from: string } }) {
  return <p id="client-only">{loaderData.from}</p>;
}
`,
  }, async (app, root) => {
    // A hydrating clientLoader: the server renders the HydrateFallback, not the component.
    const hydrating = await (await app(new Request("http://localhost/hydrating"))).text();
    assertStringIncludes(
      hydrating,
      '<p id="fallback">loading in the browser</p>',
    );
    assert(
      !hydrating.includes('id="hydrating"'),
      "the component waits for the browser",
    );
    // Without `hydrate`, the first load renders the server loader's data.
    const lazy = await (await app(new Request("http://localhost/lazy"))).text();
    assertStringIncludes(lazy, '<p id="lazy">server</p>');
    // No server loader: the clientLoader hydrates; with no fallback nothing renders yet.
    const clientOnly = await app(new Request("http://localhost/client-only"));
    assertEquals(clientOnly.status, 200);
    assert(!(await clientOnly.text()).includes('id="client-only"'));

    const dir = join(root, ".denext", "react-router");
    const hydratingClient = await Deno.readTextFile(
      join(dir, "routes__hydrating", "page.client.tsx"),
    );
    assertStringIncludes(
      hydratingClient,
      "clientLoader.hydrate = true",
      "kept with its export",
    );
    assertStringIncludes(hydratingClient, "useClientRouteData({");
    const lazyClient = await Deno.readTextFile(
      join(dir, "routes__lazy", "page.client.tsx"),
    );
    assertStringIncludes(
      lazyClient,
      "useClientRouteAction(props.id, props.formAction",
    );
    // The page's POST still runs the server action (a no-JS form submission).
    const form = new FormData();
    form.set("x", "1");
    const posted = await app(
      new Request("http://localhost/lazy", { method: "POST", body: form }),
    );
    assertEquals(await posted.json(), { ok: true });
  });
});

Deno.test("react-router plugin: `ssr: false` renders HydrateFallbacks; `prerender` sets segment config", async () => {
  await withRrApp({
    "react-router.config.ts": `export default { ssr: false, prerender: ["/about", "/teams/7"] };\n`,
    "root.tsx": CLIENT_ROOT,
    "routes.ts": `import { route } from ${JSON.stringify(DSL)};
export default [
  route("about", "routes/about.tsx"),
  route("teams/:id", "routes/team.tsx"),
];
`,
    "routes/about.tsx": `export function HydrateFallback() {
  return <p id="about-fallback">spa shell</p>;
}
export default function About() {
  return <p id="about">about</p>;
}
`,
    "routes/team.tsx": `export function loader({ params }: { params: { id: string } }) {
  return { id: params.id };
}
export default function Team({ loaderData }: { loaderData: { id: string } }) {
  return <p id="team">{loaderData.id}</p>;
}
`,
  }, async (app, root) => {
    const about = await (await app(new Request("http://localhost/about")))
      .text();
    assertStringIncludes(about, '<p id="about-fallback">spa shell</p>');
    assert(
      !about.includes('<p id="about">'),
      "SPA mode: the component renders in the browser",
    );
    const team = await (await app(new Request("http://localhost/teams/7")))
      .text();
    assert(
      !team.includes('<p id="team">'),
      "SPA mode: no server-rendered route component",
    );

    const dir = join(root, ".denext", "react-router");
    const aboutPage = await Deno.readTextFile(
      join(dir, "routes__about", "page.tsx"),
    );
    assertStringIncludes(aboutPage, 'export const dynamic = "force-static";');
    const teamPage = await Deno.readTextFile(
      join(dir, "routes__team", "page.tsx"),
    );
    assertStringIncludes(teamPage, 'return [{"id":"7"}];');
  });
});
