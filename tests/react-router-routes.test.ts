// `@denext/react-router`'s config-routing DSL (`@react-router/dev/routes` on denext) and the
// route tree it builds: RR7's own examples — nested layouts, prefixes, index routes, dynamic,
// splat and optional segments, `relative()` — resolve to the ids and full patterns RR gives them.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { index, layout, prefix, relative, route } from "../packages/react-router/routes.ts";
import {
  resolveReactRouterConfig,
  resolveRouteConfig,
} from "../packages/react-router/src/load-config.ts";
import {
  buildRouteTree,
  expandOptionalSegments,
  routeIdOf,
} from "../packages/react-router/src/route-tree.ts";

Deno.test("the DSL produces RR7-shaped entries (route / index / layout / prefix)", () => {
  assertEquals(route("about", "./routes/about.tsx"), {
    path: "about",
    file: "./routes/about.tsx",
  });
  assertEquals(
    route("teams/:id", "./routes/team.tsx", {
      id: "team",
      caseSensitive: true,
    }),
    {
      path: "teams/:id",
      file: "./routes/team.tsx",
      id: "team",
      caseSensitive: true,
    },
  );
  assertEquals(index("./routes/home.tsx"), {
    file: "./routes/home.tsx",
    index: true,
  });
  assertEquals(layout("./routes/shell.tsx", [index("./routes/home.tsx")]), {
    file: "./routes/shell.tsx",
    children: [{ file: "./routes/home.tsx", index: true }],
  });
  // route(path, file, children) — the options-less overload
  assertEquals(
    route("docs", "./routes/docs.tsx", [index("./routes/docs-home.tsx")])
      .children?.length,
    1,
  );
  // prefix: routed + index entries get the joined path; a pathless layout passes it down
  assertEquals(
    prefix("projects", [
      index("./routes/projects.tsx"),
      route(":pid", "./routes/project.tsx"),
      layout("./routes/project-layout.tsx", [
        route(":pid/edit", "./routes/edit.tsx"),
      ]),
    ]),
    [
      { file: "./routes/projects.tsx", index: true, path: "projects" },
      { path: "projects/:pid", file: "./routes/project.tsx" },
      {
        file: "./routes/project-layout.tsx",
        children: [{ path: "projects/:pid/edit", file: "./routes/edit.tsx" }],
      },
    ],
  );
  // relative(): files resolve against the directory
  const r = relative("./routes");
  assertEquals(r.route("x", "x.tsx").file, "./routes/x.tsx");
  assertEquals(r.index("home.tsx").file, "./routes/home.tsx");
  assertEquals(r.layout("shell.tsx", []).file, "./routes/shell.tsx");
});

Deno.test("buildRouteTree: ids, full patterns, layout chains (the RR7 docs' example)", () => {
  const nodes = buildRouteTree([
    index("routes/home.tsx"),
    route("about", "routes/about.tsx"),
    layout("routes/auth/layout.tsx", [
      route("login", "routes/auth/login.tsx"),
      route("register", "routes/auth/register.tsx"),
    ]),
    ...prefix("concerts", [
      index("routes/concerts/home.tsx"),
      route(":city", "routes/concerts/city.tsx"),
      route("trending", "routes/concerts/trending.tsx"),
    ]),
    route("docs/*", "routes/docs.tsx", { id: "docs-splat" }),
  ]);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  assertEquals(Object.keys(byId).sort(), [
    "docs-splat",
    "routes/about",
    "routes/auth/layout",
    "routes/auth/login",
    "routes/auth/register",
    "routes/concerts/city",
    "routes/concerts/home",
    "routes/concerts/trending",
    "routes/home",
  ]);
  assertEquals(byId["routes/home"].index, true);
  assertEquals(byId["routes/home"].pattern, "");
  assertEquals(byId["routes/auth/layout"].layout, true);
  assertEquals(
    byId["routes/auth/layout"].pattern,
    "",
    "a pathless layout adds no segment",
  );
  assertEquals(byId["routes/auth/login"].pattern, "login");
  assertEquals(byId["routes/auth/login"].parentId, "routes/auth/layout");
  assertEquals(byId["routes/auth/login"].layoutIds, ["routes/auth/layout"]);
  assertEquals(byId["routes/concerts/home"].pattern, "concerts");
  assertEquals(byId["routes/concerts/home"].index, true);
  assertEquals(byId["routes/concerts/city"].pattern, "concerts/:city");
  assertEquals(byId["docs-splat"].pattern, "docs/*");
  assertEquals(byId["routes/about"].layoutIds, []);
  assertEquals(routeIdOf("./routes/home.tsx"), "routes/home");
  assertThrows(
    () => buildRouteTree([route("a", "routes/x.tsx"), route("b", "routes/x.tsx")]),
    Error,
    "duplicate route id",
  );
});

Deno.test("expandOptionalSegments: every combination, most specific first", () => {
  assertEquals(expandOptionalSegments("docs/intro"), ["docs/intro"]);
  assertEquals(expandOptionalSegments(":lang?/docs"), [
    "/:lang/docs".slice(1),
    "docs",
  ]);
  assertEquals(expandOptionalSegments("a/:x?/b/:y?"), [
    "a/:x/b/:y",
    "a/:x/b",
    "a/b/:y",
    "a/b",
  ]);
});

Deno.test("resolveRouteConfig awaits an async config and rejects malformed entries; react-router.config defaults", async () => {
  const entries = [index("routes/home.tsx"), route("a", "routes/a.tsx")];
  assertEquals(await resolveRouteConfig({ default: entries }), entries);
  assertEquals(
    await resolveRouteConfig({ default: Promise.resolve(entries) }),
    entries,
  );
  await assertRejects(
    () => resolveRouteConfig({ default: { file: "x" } }),
    Error,
    "must default-export a route config",
  );
  await assertRejects(
    () => resolveRouteConfig({ default: [{ path: "a" }] }),
    Error,
    "every entry needs a `file`",
  );
  await assertRejects(
    () =>
      resolveRouteConfig({
        default: [{
          ...index("routes/i.tsx"),
          children: [route("x", "routes/x.tsx")],
        }],
      }),
    Error,
    "index route and cannot have children",
  );
  assertEquals(resolveReactRouterConfig({}), {
    appDirectory: "app",
    ssr: true,
  });
  assertEquals(
    resolveReactRouterConfig({
      default: { basename: "/app", ssr: false, appDirectory: "src" },
    }),
    {
      basename: "/app",
      ssr: false,
      appDirectory: "src",
    },
  );
});
