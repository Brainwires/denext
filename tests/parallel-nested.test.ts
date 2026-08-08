import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { matchPage } from "../src/router/match.ts";
import { renderPage } from "../src/server/render-page.ts";
import { defaultLoader } from "../src/server/mod.ts";

function jsx(): string {
  return new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;
}

async function app(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_pn_" });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return dir;
}

// A root layout with a @modal slot spanning all child routes.
const FILES: Record<string, string> = {
  "layout.tsx": `import { h } from "${jsx()}";\n` +
    "export default function L(p){ return h('div', null, [p.children, h('div',{id:'modal'}, p.modal)]); }\n",
  "page.tsx":
    `import { h } from "${jsx()}";\nexport default function(){ return h('main', null, 'home'); }\n`,
  "photo/[id]/page.tsx": `import { h } from "${jsx()}";\n` +
    "export default function(p){ return h('main', null, 'photo ' + p.params.id); }\n",
  "@modal/photo/[id]/page.tsx": `import { h } from "${jsx()}";\n` +
    "export default function(p){ return h('span', null, 'MODAL-' + p.params.id); }\n",
  "@modal/default.tsx":
    `import { h } from "${jsx()}";\nexport default function(){ return h('span', null, 'NO-MODAL'); }\n`,
};

Deno.test("layout-scoped slot spans child routes + falls back to default", async () => {
  const dir = await app(FILES);
  try {
    const m = await scanRoutes(dir);

    // At "/", the modal slot has no matching route -> default renders.
    const home = matchPage(m, "/")!;
    const homeHtml = (await renderPage(home, new Request("http://x/"), defaultLoader)).html;
    assertStringIncludes(homeHtml, "home");
    assertStringIncludes(homeHtml, "NO-MODAL");

    // At "/photo/5", the main photo page renders AND the modal slot matches.
    const photo = matchPage(m, "/photo/5")!;
    const photoHtml =
      (await renderPage(photo, new Request("http://x/photo/5"), defaultLoader)).html;
    assertStringIncludes(photoHtml, "photo 5");
    assertStringIncludes(photoHtml, "MODAL-5"); // slot matched the descendant URL
    assert(!photoHtml.includes("NO-MODAL"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("intercept inside a slot matches only on soft navigation", async () => {
  const dir = await app({
    ...FILES,
    // (.)photo from the @modal root intercepts /photo/[id] on soft nav.
    "@modal/(.)photo/[id]/page.tsx": `import { h } from "${jsx()}";\n` +
      "export default function(p){ return h('span', null, 'INTERCEPT-' + p.params.id); }\n",
  });
  try {
    const m = await scanRoutes(dir);
    const photo = matchPage(m, "/photo/7")!;

    // Hard load: the intercept is skipped; the real modal photo page shows.
    const hard = (await renderPage(photo, new Request("http://x/photo/7"), defaultLoader)).html;
    assertStringIncludes(hard, "MODAL-7");
    assert(!hard.includes("INTERCEPT-7"));

    // Soft nav (x-denext-nav): the intercept variant wins inside the slot.
    const soft = (await renderPage(
      photo,
      new Request("http://x/photo/7", { headers: { "x-denext-nav": "1" } }),
      defaultLoader,
    )).html;
    assertStringIncludes(soft, "INTERCEPT-7");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
