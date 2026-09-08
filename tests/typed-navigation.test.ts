// Type-safe routing beyond the path string (2.0 Pillar V, continued): the typed object form
// `{ pathname, params }`, typed `useParams<P>()`, and schema-validated `useSearchParams(schema)`.
// The compile-time guarantees are asserted by really `deno check`-ing a consumer that augments the
// navigation module's `RegisteredRoutes` (as `.denext/routes.ts` does); the runtime behavior
// (pattern filling, query validation) is asserted directly.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  formatHref,
  SearchParamsValidationError,
  useSearchParams,
} from "../src/client/navigation.ts";
import type { StandardSchemaV1 } from "../src/runtime/define-action.ts";
import type { VNode } from "../src/jsx/types.ts";

const NAV = new URL("../src/client/navigation.ts", import.meta.url).pathname;

/** `deno check` a standalone module; return its exit code (0 = type-checks). */
async function check(body: string): Promise<number> {
  const dir = await Deno.makeTempDir({ prefix: "denext-typednav-" });
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
}

// An app that has imported `.denext/routes.ts` — routes + their params registered.
const REGISTER = `declare module "${NAV}" {
  interface RegisteredRoutes {
    routes: "/" | "/about" | \`/blog/\${string}\` | \`/tag/\${string}\`;
    params: {
      "/": Record<never, never>;
      "/about": Record<never, never>;
      "/blog/[slug]": { slug: string };
      "/tag/[...tags]": { tags: string[] };
    };
  }
}`;

Deno.test("typed nav: a correct { pathname, params } object type-checks", async () => {
  assertEquals(
    await check(
      `import type { HrefInput } from "${NAV}";\n${REGISTER}\n` +
        `const a: HrefInput = { pathname: "/blog/[slug]", params: { slug: "x" } };\n` +
        `const b: HrefInput = { pathname: "/tag/[...tags]", params: { tags: ["a", "b"] } };\n` +
        `const c: HrefInput = { pathname: "/about" };\n` + // static route: no params needed
        `const s: HrefInput = "/about";\n` + // the string form still works
        `export { a, b, c, s };`,
    ),
    0,
  );
});

Deno.test("typed nav: wrong params, wrong param names, and unknown pathnames are rejected", async () => {
  const bad = async (expr: string) =>
    assertEquals(
      (await check(
        `import type { HrefInput } from "${NAV}";\n${REGISTER}\n` +
          `const x: HrefInput = ${expr};\nexport { x };`,
      )) === 0,
      false,
      `should not type-check: ${expr}`,
    );
  await bad(`{ pathname: "/blog/[slug]", params: { wrong: "x" } }`); // wrong param name
  await bad(`{ pathname: "/blog/[slug]", params: { slug: 1 } }`); // wrong param type
  await bad(`{ pathname: "/blog/[slug]" }`); // dynamic route needs params (once wired)
  await bad(`{ pathname: "/nope", params: { slug: "x" } }`); // unknown pathname
});

Deno.test("typed nav: useParams<P>() is typed to that route's params", async () => {
  // Positive: the inferred object has `slug: string`.
  assertEquals(
    await check(
      `import { useParams } from "${NAV}";\n${REGISTER}\n` +
        `function C() { const p = useParams<"/blog/[slug]">(); const s: string = p.slug; return s; }\n` +
        `export { C };`,
    ),
    0,
  );
  // Negative: a param that doesn't exist on that route is an error.
  assertEquals(
    (await check(
      `import { useParams } from "${NAV}";\n${REGISTER}\n` +
        `function C() { const p = useParams<"/blog/[slug]">(); return p.nope; }\n` +
        `export { C };`,
    )) === 0,
    false,
    "an unknown param must not type-check",
  );
});

Deno.test("typed nav: useSearchParams(schema) output type flows to the caller", async () => {
  assertEquals(
    await check(
      `import { useSearchParams } from "${NAV}";\n` +
        `import type { StandardSchemaV1 } from "${
          new URL("../src/runtime/define-action.ts", import.meta.url).pathname
        }";\n` +
        `declare const schema: StandardSchemaV1<{ page: number }>;\n` +
        `function C() { const q = useSearchParams(schema); const n: number = q.page; return n; }\n` +
        `export { C };`,
    ),
    0,
  );
});

// ---- Runtime behavior -------------------------------------------------------

Deno.test("formatHref fills a dynamic segment and appends the query", () => {
  assertEquals(
    formatHref(
      {
        pathname: "/blog/[slug]",
        params: { slug: "hello" },
        query: { page: 2 },
      } as unknown as Parameters<typeof formatHref>[0],
    ),
    "/blog/hello?page=2",
  );
});

Deno.test("formatHref joins a catch-all param with slashes", () => {
  assertEquals(
    formatHref(
      { pathname: "/tag/[...tags]", params: { tags: ["a", "b"] } } as unknown as Parameters<
        typeof formatHref
      >[0],
    ),
    "/tag/a/b",
  );
});

Deno.test("formatHref percent-encodes params so a value can't smuggle a path/query", () => {
  // A single dynamic segment: `/`, `?`, `#`, space in the value must be encoded, not literal.
  assertEquals(
    formatHref(
      { pathname: "/u/[id]", params: { id: "a/b?x=1#y z" } } as unknown as Parameters<
        typeof formatHref
      >[0],
    ),
    "/u/a%2Fb%3Fx%3D1%23y%20z",
  );
  // Catch-all: each element encoded, the `/` separators preserved.
  assertEquals(
    formatHref(
      { pathname: "/tag/[...tags]", params: { tags: ["a b", "c/d"] } } as unknown as Parameters<
        typeof formatHref
      >[0],
    ),
    "/tag/a%20b/c%2Fd",
  );
});

Deno.test("formatHref passes a plain string through and still handles a loose object", () => {
  assertEquals(formatHref("/about?x=1"), "/about?x=1");
  assertEquals(
    formatHref({ pathname: "/search", query: { q: "hi" }, hash: "top" }),
    "/search?q=hi#top",
  );
});

/** A minimal Standard Schema stub — avoids pulling a validator library into the test. */
function schemaOf<T>(
  validate: (raw: Record<string, unknown>) =>
    | { value: T }
    | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> },
): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) => validate(v as Record<string, unknown>),
    },
  };
}

Deno.test("useSearchParams(schema): a valid query yields the parsed, typed value", async () => {
  // On the server the query is empty, so the schema supplies the default.
  const schema = schemaOf<{ page: number }>((raw) => ({
    value: { page: raw.page ? Number(raw.page) : 1 },
  }));
  function Show(): VNode {
    const { page } = useSearchParams(schema);
    return h("code", null, String(page));
  }
  assertEquals(await renderToString(h(Show, null)), "<code>1</code>");
});

Deno.test("useSearchParams(schema): invalid input throws SearchParamsValidationError with field errors", async () => {
  const schema = schemaOf<{ q: string }>(() => ({
    issues: [{ message: "Required", path: ["q"] }],
  }));
  function Bad(): VNode {
    const { q } = useSearchParams(schema);
    return h("code", null, q);
  }
  const err = await assertRejects(
    () => renderToString(h(Bad, null)),
    SearchParamsValidationError,
  );
  assert(err instanceof SearchParamsValidationError);
  assertEquals(err.fieldErrors.q, "Required");
});
