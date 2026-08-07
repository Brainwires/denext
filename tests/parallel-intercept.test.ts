import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { matchPage } from "../src/router/match.ts";
import { renderPage } from "../src/server/render-page.ts";
import { defaultLoader } from "../src/server/mod.ts";
import { parseIntercept, parseSlot } from "../src/router/segments.ts";

async function buildAppTree(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_pi_" });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return { dir, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

// ---- segment parsing -------------------------------------------------------

Deno.test("parseSlot / parseIntercept recognize the markers", () => {
  assertEquals(parseSlot("@team"), "team");
  assertEquals(parseSlot("normal"), null);
  assertEquals(parseIntercept("(.)photo"), { level: "same", name: "photo" });
  assertEquals(parseIntercept("(..)photo"), { level: 1, name: "photo" });
  assertEquals(parseIntercept("(...)photo"), { level: "root", name: "photo" });
  // Plain route groups are NOT intercepts.
  assertEquals(parseIntercept("(marketing)"), null);
});

// ---- parallel routes (@slot) ----------------------------------------------

Deno.test("scanner attaches @slot pages to the level's page route", async () => {
  const { dir, cleanup } = await buildAppTree({
    "dashboard/layout.tsx": "export default function () {}\n",
    "dashboard/page.tsx": "export default function () {}\n",
    "dashboard/@team/page.tsx": "export default function () {}\n",
    "dashboard/@analytics/page.tsx": "export default function () {}\n",
  });
  try {
    const m = await scanRoutes(dir);
    // The @slot folders do not create standalone routes.
    assertEquals(m.pages.map((p) => p.routePath).sort(), ["/dashboard"]);
    const dash = m.pages.find((p) => p.routePath === "/dashboard")!;
    assertExists(dash.slots);
    assertEquals(Object.keys(dash.slots!).sort(), ["analytics", "team"]);
  } finally {
    await cleanup();
  }
});

Deno.test("slots render into the innermost layout as named props (SSR)", async () => {
  const { dir, cleanup } = await buildAppTree({
    "dashboard/layout.tsx": `import { h } from "${jsxRuntime()}";\n` +
      "export default function L(props) { return h('div', null, [props.children, props.team, props.analytics]); }\n",
    "dashboard/page.tsx": `import { h } from "${jsxRuntime()}";\n` +
      "export default function () { return h('main', null, 'page'); }\n",
    "dashboard/@team/page.tsx": `import { h } from "${jsxRuntime()}";\n` +
      "export default function () { return h('nav', null, 'team-slot'); }\n",
    "dashboard/@analytics/page.tsx": `import { h } from "${jsxRuntime()}";\n` +
      "export default function () { return h('aside', null, 'analytics-slot'); }\n",
  });
  try {
    const m = await scanRoutes(dir);
    const match = matchPage(m, "/dashboard");
    assertExists(match);
    const { html } = await renderPage(match, new Request("http://x/dashboard"), defaultLoader);
    // Main page + both slots appear in the rendered layout.
    assertEquals(html.includes("main") && html.includes(">page<"), true);
    assertEquals(html.includes("team-slot"), true);
    assertEquals(html.includes("analytics-slot"), true);
  } finally {
    await cleanup();
  }
});

// ---- intercepting routes ((.)/(..)/(...)) ---------------------------------

Deno.test("(..) is parsed as an intercept, not mis-stripped as a route group", async () => {
  const { dir, cleanup } = await buildAppTree({
    "feed/photo/page.tsx": "export default function () {}\n",
    // From /feed/[id], (..)photo reaches one level up -> /feed/photo.
    "feed/[id]/(..)photo/page.tsx": "export default function () {}\n",
  });
  try {
    const m = await scanRoutes(dir);
    const photo = m.pages.filter((p) => p.routePath === "/feed/photo");
    // Two routes at /feed/photo: the real one and the intercept variant.
    assertEquals(photo.length, 2);
    assertEquals(photo.some((p) => p.intercept), true);
    assertEquals(photo.some((p) => !p.intercept), true);
  } finally {
    await cleanup();
  }
});

Deno.test("intercept routes match only on soft navigation", async () => {
  const { dir, cleanup } = await buildAppTree({
    "feed/page.tsx": "export default function () {}\n",
    "feed/photo/page.tsx": "export default function () {}\n",
    "feed/(.)photo/page.tsx": "export default function () {}\n",
  });
  try {
    const m = await scanRoutes(dir);

    // Hard load: the real (non-intercept) route.
    const hard = matchPage(m, "/feed/photo");
    assertExists(hard);
    assertEquals(hard.route.intercept, undefined);
    assertEquals(hard.route.filePath.endsWith(join("photo", "page.tsx")), true);

    // Soft nav: the intercept variant wins.
    const soft = matchPage(m, "/feed/photo", { soft: true });
    assertExists(soft);
    assertExists(soft.route.intercept);
  } finally {
    await cleanup();
  }
});

function jsxRuntime(): string {
  // Absolute file URL to the framework's JSX runtime for the fixture modules.
  return new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href;
}
