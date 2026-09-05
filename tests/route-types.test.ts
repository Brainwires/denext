// Typed-routes generator (2.0 Pillar V): manifest → a TS type module for navigation.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { generateRouteTypes } from "../src/build/route-types.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { ApiRoute, PageRoute, RouteManifest } from "../src/router/manifest.ts";

const pat = (rp: string) => (rp === "/" ? [] : parsePattern(rp.slice(1)));
const page = (
  rp: string,
) => ({ kind: "page", routePath: rp, pattern: pat(rp) } as unknown as PageRoute);
const api = (
  rp: string,
) => ({ kind: "api", routePath: rp, pattern: pat(rp) } as unknown as ApiRoute);
const manifest = (
  pages: PageRoute[],
  apis: ApiRoute[] = [],
): RouteManifest => ({
  pages,
  api: apis,
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
} as RouteManifest);

Deno.test("route-types: static + root routes are string literals", () => {
  const out = generateRouteTypes(manifest([page("/"), page("/about")]));
  assertStringIncludes(out, 'export type Routes = "/" | "/about";');
});

Deno.test("route-types: a dynamic segment → template literal + params entry", () => {
  const out = generateRouteTypes(manifest([page("/blog/[slug]")]));
  assertStringIncludes(out, "`/blog/${string}`");
  assertStringIncludes(out, '"/blog/[slug]": { "slug": string };');
});

Deno.test("route-types: a catch-all spans the tail", () => {
  const out = generateRouteTypes(manifest([page("/docs/[...rest]")]));
  assertStringIncludes(out, "`/docs/${string}`");
  assertStringIncludes(out, '"/docs/[...rest]": { "rest": string[] };');
});

Deno.test("route-types: an optional catch-all yields with- and without-tail variants", () => {
  const out = generateRouteTypes(manifest([page("/shop/[[...path]]")]));
  assertStringIncludes(out, '"/shop"'); // prefix (no tail)
  assertStringIncludes(out, "`/shop/${string}`"); // prefix + tail
});

Deno.test("route-types: API routes get their own union", () => {
  const out = generateRouteTypes(manifest([], [api("/api/users/[id]")]));
  assertStringIncludes(out, "export type ApiRoutes = `/api/users/${string}`;");
});

Deno.test("route-types: an empty manifest yields never", () => {
  const out = generateRouteTypes(manifest([]));
  assertStringIncludes(out, "export type Routes = never;");
});

Deno.test("route-types: registering routes narrows Href and rejects unknown paths", async () => {
  const nav = new URL("../src/client/navigation.ts", import.meta.url).pathname;
  const check = async (body: string): Promise<number> => {
    const dir = await Deno.makeTempDir({ prefix: "denext-href-" });
    try {
      await Deno.writeTextFile(`${dir}/t.ts`, body);
      const { code } = await new Deno.Command(Deno.execPath(), {
        args: ["check", `${dir}/t.ts`],
        stderr: "null",
        stdout: "null",
      }).output();
      return code;
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  };
  const register = `declare module "${nav}" {\n` +
    `  interface RegisteredRoutes { routes: "/" | "/about" | \`/blog/\${string}\`; }\n}`;

  // A valid path compiles once routes are registered.
  assertEquals(
    await check(
      `import type { Href } from "${nav}";\n${register}\n` +
        `const a: Href = "/about"; const b: Href = \`/blog/\${"x"}\`; export { a, b };`,
    ),
    0,
  );
  // An unknown path must fail typechecking.
  assertEquals(
    (await check(
      `import type { Href } from "${nav}";\n${register}\n` +
        `const c: Href = "/nope"; export { c };`,
    )) === 0,
    false,
    "an unregistered path must not typecheck",
  );
});

Deno.test("route-types: the generated module compiles and its types are usable", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-routetypes-" });
  try {
    await Deno.writeTextFile(
      `${dir}/routes.ts`,
      generateRouteTypes(manifest([page("/"), page("/blog/[slug]")], [api("/api/ping")])),
    );
    // A consumer exercising Routes + ParamsOf + ApiRoutes — must type-check.
    await Deno.writeTextFile(
      `${dir}/consumer.ts`,
      [
        `import type { ApiRoutes, ParamsOf, Routes } from "./routes.ts";`,
        `const home: Routes = "/";`,
        `const post: Routes = \`/blog/\${"hello"}\`;`,
        `const params: ParamsOf<"/blog/[slug]"> = { slug: "hello" };`,
        `const ping: ApiRoutes = "/api/ping";`,
        `export { home, post, params, ping };`,
      ].join("\n"),
    );
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["check", `${dir}/consumer.ts`],
      stderr: "piped",
      stdout: "null",
    }).output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
