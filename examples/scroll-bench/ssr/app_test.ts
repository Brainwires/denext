// Every route of the server-rendered bench renders its cell with no browser: the static impls
// every row, the islands impls one island per row (or one for the list), the virtual impls
// only the first window.

import { assert, assertEquals } from "@std/assert";
import { createTestApp, createTestClient } from "denext/testing";
import { fileURLToPath } from "node:url";

const client = createTestClient(await createTestApp(fileURLToPath(new URL(".", import.meta.url))));
const count = (html: string, needle: string) => html.split(needle).length - 1;
const get = async (path: string) => {
  const res = await client.get(path);
  assertEquals(res.status, 200, path);
  return res.text;
};

Deno.test("static and static-cv: every row as HTML, no island", async () => {
  for (const impl of ["static", "static-cv"]) {
    const html = await get(`/list/${impl}?kind=fixed&n=250`);
    assertEquals(count(html, 'role="listitem"'), 250, impl);
    assertEquals(count(html, "data-dnx-island"), 0, impl);
  }
  assert((await get("/list/static-cv?kind=chat&n=5")).includes("sb-cv k-chat"));
});

Deno.test("row controls: an island per row, a resumable island per row, or one island", async () => {
  const islands = await get("/list/static-cv-islands?kind=fixed&n=40");
  assertEquals(count(islands, 'data-dnx-strategy="load"'), 40);
  const resumable = await get("/list/static-cv-resumable?kind=fixed&n=40");
  assertEquals(count(resumable, 'data-dnx-strategy="interaction"'), 40);
  assertEquals(count(resumable, 'data-dnx-h="click"'), 40);
  const delegated = await get("/list/static-cv-delegated?kind=fixed&n=40");
  assertEquals(count(delegated, "data-dnx-island "), 1);
  assertEquals(count(delegated, 'data-like=""'), 40); // plain server buttons
  const script = await get("/list/static-cv-script?kind=fixed&n=40");
  assertEquals(count(script, "data-dnx-island"), 0);
  assert(script.includes('src="/like-delegate.js"'));
});

Deno.test("virtual islands: the first window only, as one island", async () => {
  const html = await get("/list/virtual-island?kind=fixed&n=100000");
  assertEquals(count(html, 'data-dnx-strategy="load"'), 1);
  const rows = count(html, 'role="listitem"');
  assert(rows > 5 && rows < 100, `${rows} rows in the first window`);
  assert(html.includes('aria-setsize="100000"'));
  const visible = await get("/list/virtual-island-visible?kind=chat&n=1000");
  assertEquals(count(visible, 'data-dnx-strategy="visible"'), 1);
  assert(visible.includes('class="sb-intro"'));
  assert((await get("/list/virtual-island-find?kind=images&n=50")).includes("data-dnx-island"));
});
