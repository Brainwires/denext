// `RequestContext.renderPageForMethod`: a middleware that handled a non-GET request for a page
// (the Fresh compat runs a page route's POST handler there) hands it to the page render; without
// the flag a POST to a page stays a 405, and a page next to a `route.ts` still falls through only
// when it is set.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createTestApp, createTestClient } from "../src/testing/mod.ts";

const JSX = new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;
const RC = new URL("../src/server/request-context.ts", import.meta.url).href;

async function withApp<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_page_method_" });
  try {
    for (const [rel, src] of Object.entries(files)) {
      const path = join(dir, rel);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, src);
    }
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const APP = {
  "app/layout.ts": `import { h } from "${JSX}";
export default function Root({ children }) { return h("main", null, children); }`,
  "app/page.ts": `import { h } from "${JSX}";
export default function Home() { return h("p", null, "home page"); }`,
  "app/both/page.ts": `import { h } from "${JSX}";
export default function Both() { return h("p", null, "both page"); }`,
  "app/both/route.ts": `export function PUT() { return new Response("put"); }`,
  "middleware.ts": `import { currentContext } from "${RC}";
export default function mw(request) {
  if (new URL(request.url).searchParams.has("render")) currentContext().renderPageForMethod = true;
}`,
};

Deno.test("a POST a middleware hands to the page renders it; otherwise it is a 405", async () => {
  await withApp(APP, async (dir) => {
    const client = createTestClient(await createTestApp(dir));
    assertEquals((await client.post("/", { form: { a: "1" } })).status, 405);
    const handed = await client.post("/?render", { form: { a: "1" } });
    assertEquals(handed.status, 200);
    assertStringIncludes(handed.text, "home page");
    // Beside a route.ts that lacks the method: the page renders only when handed over.
    assertEquals((await client.post("/both", { form: { a: "1" } })).status, 405);
    assertStringIncludes((await client.post("/both?render", { form: {} })).text, "both page");
    assertEquals((await client.request("/both", { method: "PUT" })).text, "put");
  });
});
