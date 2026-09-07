// `@denext/react-router` end to end, in process: a React Router v7 framework-mode app
// (root.tsx with a `Layout` export, `app/routes.ts` config routing with a pathless layout,
// a prefix, an index, a dynamic route with a loader + action, a resource route, a route whose
// loader throws) → `applyPlugins` → `scanRoutes` (the synthesizer generates the wrappers into
// .denext/react-router and adds the routes) → `createApp` renders them: loader data reaches
// the component as PROPS and through `useLoaderData`, the action answers a POST, the resource
// route answers GET, the thrown Response reaches the route's ErrorBoundary with its status.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { reactRouter } from "../packages/react-router/mod.ts";
import { applyPlugins, resetPlugins } from "../src/plugin/mod.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createApp } from "../src/server/app.ts";
import { defaultLoader } from "../src/server/mod.ts";

const DSL = toFileUrl(new URL("../packages/react-router/routes.ts", import.meta.url).pathname).href;

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
  const tmpBase = new URL("./.tmp/", import.meta.url).pathname;
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
      manifest.rootLayout?.endsWith("/.denext/react-router/root/layout.tsx"),
      manifest.rootLayout ?? "",
    );
    const team = manifest.pages.find((p) => p.routePath === "/teams/[id]")!;
    assertEquals(team.layoutChain.length, 2, "root + the pathless shell layout");
    assertEquals(team.layoutDepths, [0, 0]);
    assert(team.filePath.includes("/.denext/react-router/routes__teams__team/page.tsx"));
    const boom = manifest.pages.find((p) => p.routePath === "/boom")!;
    assert(
      boom.error?.endsWith("/routes__boom/error.tsx"),
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
