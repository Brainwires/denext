// `@denext/react-router` end to end, in process: a React Router v7 framework-mode app
// (root.tsx with a `Layout` export, `app/routes.ts` config routing with a pathless layout,
// a prefix, an index, a dynamic route with a loader + action, a resource route, a route whose
// loader throws) → `applyPlugins` → `scanRoutes` (the synthesizer generates the wrappers into
// .denext/react-router and adds the routes) → `createApp` renders them: loader data reaches
// the component as PROPS and through `useLoaderData`, the action answers a POST, the resource
// route answers GET, the thrown Response reaches the route's ErrorBoundary with its status.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { reactRouter, type ReactRouterOptions } from "../packages/react-router/mod.ts";
import { clearLoadContext } from "../src/compat/remix/load-context.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createApp } from "./helpers/released-app.ts";
import { defaultLoader } from "../src/server/mod.ts";
import { PageCache } from "../src/server/cache.ts";

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
    // The scan also wrote React Router's route types (`./+types/<route>` via rootDirs).
    const types = await Deno.readTextFile(
      join(root, ".react-router", "types", "app", "routes", "teams", "+types", "team.ts"),
    );
    assertStringIncludes(types, "export namespace Route");
    assertStringIncludes(types, `type Params = { "id": string };`);
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
  options: { pageCache?: PageCache; plugin?: ReactRouterOptions; flight?: boolean } = {},
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
      config: { plugins: [reactRouter(options.plugin)] },
      mode: "build",
      load: defaultLoader,
    });
    const manifest = await scanRoutes(join(root, "app"));
    const app = createApp({
      getManifest: () => manifest,
      load: defaultLoader,
      pageCache: options.pageCache,
      ...(options.flight
        ? { flight: true, appDir: join(root, "app"), flightRoutes: new Set(["/teams/[id]"]) }
        : {}),
    });
    await run(app, root);
  } finally {
    clearLoadContext();
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
    // Imports `useActionData` itself: the generated boundary's own hooks must not clash.
    "routes/lazy.tsx": `import { useActionData } from "react-router";
export function loader() {
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
  const done = useActionData<{ ok: boolean }>();
  return <p id="lazy">{loaderData.from}{done ? " saved" : ""}</p>;
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

// A hook-free root (`Layout` + an `App` that only returns `<Outlet/>`) is a SERVER root layout.
// Its generated layout must render the route through `Layout` — `return <Outlet/>;` once became
// `return {children};` (an object literal, rendered as `<undefined>`) and `Layout` was dropped.
const SERVER_ROOT = `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
export function Layout({ children }: { children: unknown }) {
  return (
    <html lang="en" className="dark">
      <head><Meta /><Links /></head>
      <body data-app="rr7s">{children}<ScrollRestoration /><Scripts /></body>
    </html>
  );
}
export default function App() {
  return <Outlet />;
}
`;

Deno.test("react-router plugin: a hook-free root with Layout + `return <Outlet/>` renders the route", async () => {
  await withRrApp({
    "root.tsx": SERVER_ROOT,
    "routes.ts": `import { index } from ${JSON.stringify(DSL)};
export default [index("routes/home.tsx")];
`,
    "routes/home.tsx": `export default function Home() {
  return <h1 id="home">home</h1>;
}
`,
  }, async (app, root) => {
    const layout = await Deno.readTextFile(
      join(root, ".denext", "react-router", "root", "layout.tsx"),
    );
    assert(!layout.includes("return {children}"), layout);
    const html = await (await app(new Request("http://localhost/"))).text();
    assertStringIncludes(html, '<h1 id="home">home</h1>');
    assertStringIncludes(html, 'data-app="rr7s"', "the root Layout export renders the body");
    assert(!html.includes("<undefined"), html);
  });
});

// Audit 3.4.0 B1: `prerender` makes a listed route `force-static` (cached for everyone). React
// Router prerenders with a build-time request that carries no cookies, so a root loader that
// reads `request.headers` must see none under `force-static` — the first visitor's cookie must
// never reach the page cache that every later visitor is served from.
Deno.test("react-router plugin: a prerendered route's loader gets no request headers (no cross-user cache)", async () => {
  await withRrApp({
    "react-router.config.ts": `export default { prerender: true };\n`,
    "root.tsx": `import { Outlet } from "react-router";
export function loader({ request }: { request: Request }) {
  return { who: request.headers.get("cookie") ?? "anonymous" };
}
export function Layout({ children }: { children: unknown }) {
  return <html lang="en"><head /><body>{children}</body></html>;
}
export default function App({ loaderData }: { loaderData: { who: string } }) {
  return <main><p id="who">{loaderData.who}</p><Outlet /></main>;
}
`,
    "routes.ts": `import { route } from ${JSON.stringify(DSL)};
export default [route("about", "routes/about.tsx")];
`,
    "routes/about.tsx": `export default function About() {
  return <p id="about">about</p>;
}
`,
  }, async (app) => {
    const visit = async (cookie: string) =>
      await (await app(new Request("http://localhost/about", { headers: { cookie } }))).text();
    const first = await visit("user=alice");
    const second = await visit("user=bob");
    assertStringIncludes(second, '<p id="about">about</p>');
    assert(!second.includes("alice"), "the second visitor must not see the first visitor's data");
    assertStringIncludes(second, '<p id="who">anonymous</p>');
    assert(!first.includes("alice"), "the prerendered page never carries a visitor's cookie");
  }, { pageCache: new PageCache() });
});

// React Router 7 middleware + typed context (roadmap P3): `getLoadContext` from the plugin
// options, `createContext` keys, and `middleware` / `unstable_middleware` exports on the root, a
// pathless layout and a page — run outermost first, once per request, before the loaders; a
// thrown redirect stops the request; on a resource route `next()` wraps the real handler.
Deno.test("react-router plugin: route middleware + typed context reach every loader", async () => {
  await withRrApp({
    "context.ts": `import { createContext } from "denext/remix";
export const trail = createContext<string[]>([]);
export const user = createContext<string>("anonymous");
`,
    "root.tsx": `import { Outlet } from "react-router";
import { trail } from "./context.ts";
export const middleware = [
  async ({ context }, next) => {
    context.set(trail, [...context.get(trail), "root"]);
    const response = await next();
    response.headers.set("x-root-middleware", "ran");
    return response;
  },
];
export function loader({ context }) {
  return { depth: context.get(trail).length };
}
export function Layout({ children }: { children: unknown }) {
  return <html lang="en"><head /><body>{children}</body></html>;
}
export default function App({ loaderData }: { loaderData: { depth: number } }) {
  return <main><p id="depth">{loaderData.depth}</p><Outlet /></main>;
}
`,
    "routes.ts": `import { layout, route } from ${JSON.stringify(DSL)};
export default [
  layout("routes/shell.tsx", [route("teams/:id", "routes/team.tsx")]),
  route("api/trail", "routes/api.ts"),
];
`,
    "routes/shell.tsx": `import { Outlet } from "react-router";
import { trail } from "../context.ts";
export const unstable_middleware = [({ context }) => {
  context.set(trail, [...context.get(trail), "shell"]);
}];
export default function Shell() {
  return <section><Outlet /></section>;
}
`,
    "routes/team.tsx": `import { redirect } from "react-router";
import { trail, user } from "../context.ts";
export const middleware = [({ request, params, context }, next) => {
  if (params.id === "blocked") throw redirect("/teams/1");
  const who = request.headers.get("x-user");
  if (who) context.set(user, who);
  context.set(trail, [...context.get(trail), "team"]);
  return next();
}];
export function loader({ context }) {
  return { trail: context.get(trail).join(">"), user: context.get(user), tenant: context.tenant };
}
export default function Team({ loaderData }: { loaderData: { trail: string; user: string; tenant: string } }) {
  return <p id="team">{loaderData.trail}|{loaderData.user}|{loaderData.tenant}</p>;
}
`,
    "routes/api.ts": `import { trail } from "../context.ts";
export function loader({ context }) {
  return { trail: context.get(trail), tenant: context.tenant };
}
`,
  }, async (app) => {
    const res = await app(
      new Request("http://localhost/teams/7", { headers: { "x-user": "alice" } }),
    );
    const html = await res.text();
    assertEquals(res.status, 200);
    // Outermost first, each route's middleware once (the metadata pass and the render share
    // the run), then the loaders read what they set — and the config's getLoadContext value.
    assertStringIncludes(html, '<p id="team">root&gt;shell&gt;team|alice|acme</p>');
    assertEquals(res.headers.get("x-root-middleware"), "ran", "a header set on next()'s response");

    const anonymous = await (await app(new Request("http://localhost/teams/8"))).text();
    assertStringIncludes(anonymous, "|anonymous|acme</p>", "a key's default value");

    const blocked = await app(new Request("http://localhost/teams/blocked"));
    assertEquals(blocked.status, 302, "a middleware's thrown redirect answers the request");
    assertEquals(blocked.headers.get("location"), "/teams/1");

    // A resource route: the root's middleware wraps the loader's own response.
    const api = await app(new Request("http://localhost/api/trail"));
    assertEquals(await api.json(), { trail: ["root"], tenant: "acme" });
    assertEquals(api.headers.get("x-root-middleware"), "ran");
  }, { plugin: { getLoadContext: () => ({ tenant: "acme" }) } });
});

// React Router's server middleware wraps the whole request: the innermost `next()` serves the
// page — loaders, render and document (or a client navigation's payload) — and resolves to the
// response the browser gets, outermost route first, sharing the request's context.
const WRAPPING_APP: Record<string, string> = {
  "context.ts": `import { createContext } from "denext/remix";
export const log = createContext<string[] | null>(null);
`,
  "root.tsx": `import { Outlet, useRouteError } from "react-router";
import { log } from "./context.ts";
export const middleware = [
  async ({ request, context }, next) => {
    const order: string[] = ["root"];
    context.set(log, order);
    if (new URL(request.url).searchParams.has("short")) {
      return new Response("short-circuited", { status: 418 });
    }
    const response = await next();
    order.push("root-after");
    response.headers.set("x-seen", response.status + " " + response.headers.get("content-type"));
    response.headers.set("x-order", order.join(">"));
    if (response.status === 500) return new Response("replaced", { status: 503 });
    return response;
  },
];
export function Layout({ children }: { children: unknown }) {
  return <html lang="en"><head /><body>{children}</body></html>;
}
export default function App() {
  return <Outlet />;
}
export function ErrorBoundary() {
  return <p id="root-error">{String(useRouteError())}</p>;
}
`,
  "routes.ts": `import { layout, route } from ${JSON.stringify(DSL)};
export default [
  layout("routes/shell.tsx", [
    route("teams/:id", "routes/team.tsx"),
    route("boom", "routes/boom.tsx"),
  ]),
];
`,
  "routes/shell.tsx": `import { Outlet } from "react-router";
import { log } from "../context.ts";
export const middleware = [async ({ context }, next) => {
  context.get(log)?.push("shell");
  const response = await next();
  context.get(log)?.push("shell-after");
  return response;
}];
export default function Shell() {
  return <section><Outlet /></section>;
}
`,
  "routes/team.tsx": `import { log } from "../context.ts";
export const middleware = [async ({ context }, next) => {
  context.get(log)?.push("team");
  const response = await next();
  context.get(log)?.push("team-after");
  return response;
}];
export function loader({ context, params }) {
  context.get(log)?.push("loader");
  return { id: params.id };
}
export default function Team({ loaderData }: { loaderData: { id: string } }) {
  return <p id="team">team {loaderData.id}</p>;
}
`,
  "routes/boom.tsx": `export function loader() {
  throw new Error("render failed");
}
export default function Boom() {
  return <p>never</p>;
}
`,
};

/** Run `run` against {@link WRAPPING_APP} (Flight on, as a built app serves it). */
function withWrappingApp(run: (app: (req: Request) => Promise<Response>) => Promise<void>) {
  return withRrApp(WRAPPING_APP, (app) => run(app), { flight: true });
}

const WRAPPED_ORDER = "root>shell>team>loader>team-after>shell-after>root-after";

Deno.test("react-router plugin: a middleware's header after next() lands on the rendered document", async () => {
  await withWrappingApp(async (app) => {
    const res = await app(new Request("http://localhost/teams/7"));
    assertStringIncludes(await res.text(), '<p id="team">team');
    assertEquals(res.status, 200);
    // next() resolved to the rendered HTML response itself, not a stand-in.
    assertStringIncludes(res.headers.get("x-seen") ?? "", "200 text/html");
  });
});

Deno.test("react-router plugin: middleware runs outermost first around nested routes' loaders", async () => {
  await withWrappingApp(async (app) => {
    const res = await app(new Request("http://localhost/teams/7"));
    await res.body?.cancel();
    // In on the way down, out on the way up, the loaders in between; one shared context.
    assertEquals(res.headers.get("x-order"), WRAPPED_ORDER);
  });
});

Deno.test("react-router plugin: middleware wraps a client navigation's data request", async () => {
  await withWrappingApp(async (app) => {
    const nav = await app(
      new Request("http://localhost/teams/8", { headers: { "x-denext-nav": "1" } }),
    );
    await nav.body?.cancel();
    assertEquals(nav.status, 200);
    assertEquals(nav.headers.get("x-denext-flight"), "1");
    assertStringIncludes(nav.headers.get("x-seen") ?? "", "200 application/json");
    assertEquals(nav.headers.get("x-order"), WRAPPED_ORDER);
  });
});

Deno.test("react-router plugin: a render error reaches next() as its response, which middleware replaces", async () => {
  await withWrappingApp(async (app) => {
    const boom = await app(new Request("http://localhost/boom"));
    assertEquals(boom.status, 503);
    assertEquals(await boom.text(), "replaced");
  });
});

Deno.test("react-router plugin: a middleware's own Response without next() short-circuits the render", async () => {
  await withWrappingApp(async (app) => {
    const short = await app(new Request("http://localhost/teams/9?short"));
    assertEquals(short.status, 418);
    assertEquals(await short.text(), "short-circuited");
  });
});
