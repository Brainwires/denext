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

// ---- Soft-navigation slot state (Next.js: unmatched slots keep their content) ----------

import { assertEquals } from "@std/assert";
import { createApp } from "../src/server/app.ts";

/** The playground's dashboard shape under `dash/`: a `children` page + an `@audience` slot. */
const SLOT_STATE_FILES: Record<string, string> = {
  "layout.tsx": `import { h } from "${jsx()}";\n` +
    "export default function R(p){ return h('html', null, h('body', null, p.children)); }\n",
  "dash/layout.tsx": `import { h } from "${jsx()}";\n` +
    "export default function L(p){ return h('div', null, [h('main', null, p.children), h('aside', null, p.audience)]); }\n",
  "dash/page.tsx":
    `import { h } from "${jsx()}";\nexport default function(){ return h('b', null, 'CHANNEL'); }\n`,
  "dash/default.tsx":
    `import { h } from "${jsx()}";\nexport default function(){ return h('b', null, 'CHILD-DEFAULT'); }\n`,
  "dash/@audience/default.tsx":
    `import { h } from "${jsx()}";\nexport default function(){ return h('i', null, 'AUD-DEFAULT'); }\n`,
  "dash/@audience/demographics/page.tsx":
    `import { h } from "${jsx()}";\nexport default function(){ return h('i', null, 'AUD-DEMO'); }\n`,
  "other/page.tsx":
    `import { h } from "${jsx()}";\nexport default function(){ return h('b', null, 'OTHER'); }\n`,
};

/** Soft-nav helpers: HTML from a no-client-entry app, the recorded state from an entry app's payload. */
async function slotStateApp() {
  const dir = await app(SLOT_STATE_FILES);
  const manifest = await scanRoutes(dir);
  const htmlApp = createApp({ getManifest: () => manifest, load: defaultLoader });
  const entryApp = createApp({
    getManifest: () => manifest,
    load: defaultLoader,
    clientEntryFor: () => "/_denext/entry.js",
  });
  const headers = (slotState?: unknown): Record<string, string> =>
    slotState === undefined
      ? {}
      : { "x-denext-nav": "1", "x-denext-slot-state": JSON.stringify(slotState) };
  const html = async (path: string, slotState?: unknown) =>
    await (await htmlApp(new Request(`http://x${path}`, { headers: headers(slotState) }))).text();
  const state = async (path: string, slotState?: unknown) => {
    const res = await entryApp(new Request(`http://x${path}`, { headers: headers(slotState) }));
    const body = await res.text();
    const data = slotState === undefined
      ? JSON.parse(body.match(/<script id="__denext_data"[^>]*>([^<]*)<\/script>/)![1])
      : JSON.parse(body).data;
    return data.slotState as Record<string, string> | undefined;
  };
  return { dir, html, state };
}

Deno.test("slot state: a HARD load of a slot-only URL renders default.tsx and records the state", async () => {
  const { dir, html, state } = await slotStateApp();
  try {
    const home = await html("/dash");
    assertStringIncludes(home, "CHANNEL");
    assertStringIncludes(home, "AUD-DEFAULT");
    assertEquals(await state("/dash"), { children: "/dash" });

    const demo = await html("/dash/demographics");
    assertStringIncludes(demo, "CHILD-DEFAULT");
    assertStringIncludes(demo, "AUD-DEMO");
    assertEquals(await state("/dash/demographics"), {
      children: "/dash/demographics",
      "1:audience": "/dash/demographics",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("slot state: a SOFT navigation keeps the page and unmatched slots the client was showing", async () => {
  const { dir, html, state } = await slotStateApp();
  try {
    // From "/dash" to the slot-only "/dash/demographics": children keeps the "/dash" page.
    const demo = await html("/dash/demographics", { children: "/dash" });
    assertStringIncludes(demo, "CHANNEL");
    assertStringIncludes(demo, "AUD-DEMO");
    assert(!demo.includes("CHILD-DEFAULT"));
    const demoState = await state("/dash/demographics", { children: "/dash" });
    assertEquals(demoState, { children: "/dash", "1:audience": "/dash/demographics" });

    // Back to "/dash": the @audience slot no longer matches but keeps demographics.
    const home = await html("/dash", demoState);
    assertStringIncludes(home, "CHANNEL");
    assertStringIncludes(home, "AUD-DEMO");
    assert(!home.includes("AUD-DEFAULT"));
    assertEquals(await state("/dash", demoState), {
      children: "/dash",
      "1:audience": "/dash/demographics",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("slot state: a remembered page under OTHER layouts, or a malformed header, falls back to default.tsx", async () => {
  const { dir, html } = await slotStateApp();
  try {
    // "/other" is not under dash/layout.tsx: it cannot stand in for the dash children.
    const foreign = await html("/dash/demographics", { children: "/other" });
    assertStringIncludes(foreign, "CHILD-DEFAULT");
    assert(!foreign.includes("OTHER"));

    const junk = await html("/dash/demographics", { children: "http://evil/", "1:audience": 42 });
    assertStringIncludes(junk, "CHILD-DEFAULT");
    assertStringIncludes(junk, "AUD-DEMO");

    const empty = createApp({
      getManifest: () => ({
        pages: [],
        api: [],
        rootLayout: null,
        rootNotFound: null,
        rootGlobalError: null,
      }),
      load: defaultLoader,
    });
    const res = await empty(
      new Request("http://x/", {
        headers: { "x-denext-nav": "1", "x-denext-slot-state": "{not json" },
      }),
    );
    assertEquals(res.status, 404); // parsed defensively: no throw, plain 404
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
