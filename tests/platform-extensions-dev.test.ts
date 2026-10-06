// Platform-specific files in `denext dev`: a shell names its target
// (`?__denext_platform=ios`, which `denext mobile dev` writes into each native config's
// `server.url`, or the desktop proxy's `x-denext-platform` header); the dev server pins it in a
// cookie, renders that target's files on the server, and serves the page's modules resolved for
// it — while a browser with no hint keeps getting `web`, and neither target's cached transforms
// leak into the other's.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startDevServer } from "../src/build/dev-server.ts";
import { resolveProject } from "../src/build/paths.ts";
import { createUnbundledDev } from "../src/build/dev-unbundled.ts";
import { platformResolution } from "../src/build/platform-extensions.ts";

const abs = (rel: string) => new URL(`../${rel}`, import.meta.url).href;

async function project(
  files: Record<string, string>,
  imports: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_platform_dev_" }));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
        ...imports,
      },
    }),
  );
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
  return dir;
}

const badge = (label: string) =>
  `"use client"\nimport { useState } from "denext";\n` +
  `export function Badge(){ const [n] = useState(0); return <b>${label}{n}</b>; }\n`;

Deno.test("unbundled dev: each target's module rewrite names its own platform file", async () => {
  const dir = await project({
    "src/main.ts": `import { label } from "./label";\nconsole.log(label);\n`,
    "src/label.ts": `export const label = "PLAIN";\n`,
    "src/label.ios.ts": `export const label = "IOS";\n`,
  });
  const dev = createUnbundledDev({
    projectDir: dir,
    appDir: join(dir, "src"),
    configPath: join(dir, "deno.json"),
    outDir: join(dir, ".denext"),
    compat: false,
    resolvePlatform: (p) => platformResolution({}, p),
  });
  try {
    const main = join(dir, "src", "main.ts");
    const ios = (await dev._internal.transform(main, "ios")).code;
    const web = (await dev._internal.transform(main, "web")).code;
    assertStringIncludes(ios, "/src/label.ios.ts?v=");
    assertStringIncludes(web, "/src/label.ts?v=");
    assert(!web.includes("label.ios.ts"), "the web transform is its own cache entry");
    // Served over HTTP: the cookie (or the desktop proxy's header) picks the target.
    const url = new URL(`http://dev/_denext/@fs${main}`);
    const served = async (headers: Record<string, string>) =>
      await (await dev.handle(new Request(url, { headers }), url, { pages: [] } as never))!
        .text();
    assertStringIncludes(await served({ cookie: "__denext_platform=ios" }), "label.ios.ts");
    assertStringIncludes(await served({ "x-denext-platform": "ios" }), "label.ios.ts");
    assert(!(await served({})).includes("label.ios.ts"), "no hint is web");
    assert(!(await served({ cookie: "__denext_platform=nope" })).includes("label.ios.ts"));
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext dev: ?__denext_platform pins the target; SSR and the Flight islands follow it", async () => {
  const dir = await project({
    "app/page.tsx": `import { Badge } from "../components/Badge.tsx";\n` +
      `export default function Page(){ return <main><Badge/></main>; }\n`,
    "components/Badge.tsx": badge("PLAIN_BADGE"),
    "components/Badge.ios.tsx": badge("IOS_BADGE"),
  });
  const controller = new AbortController();
  try {
    const paths = await resolveProject(dir);
    const port = await new Promise<number>((resolve) => {
      startDevServer({
        paths,
        port: 0,
        hostname: "127.0.0.1",
        signal: controller.signal,
        onListen: ({ port }) => resolve(port),
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path: string, headers: Record<string, string> = {}) =>
      fetch(base + path, { headers });

    const iosPage = await get("/?__denext_platform=ios");
    assertStringIncludes(iosPage.headers.get("set-cookie") ?? "", "__denext_platform=ios");
    const iosHtml = await iosPage.text();
    assertStringIncludes(iosHtml, "IOS_BADGE", "the server render took the iOS file");
    assert(!iosHtml.includes("PLAIN_BADGE"));
    const cookie = { cookie: "__denext_platform=ios" };
    const iosFlight = await (await get("/_denext/flight.js", cookie)).text();
    assertStringIncludes(iosFlight, "Badge.ios.tsx", "the island entry imports the iOS file");

    // A browser with no hint is web, before and after the iOS requests.
    const webHtml = await (await get("/")).text();
    assertStringIncludes(webHtml, "PLAIN_BADGE");
    assert(!webHtml.includes("IOS_BADGE"));
    const webFlight = await (await get("/_denext/flight.js")).text();
    assert(!webFlight.includes("Badge.ios.tsx"), "the web entry keeps the plain file");
    assertEquals(
      (await (await get("/", cookie)).text()).includes("IOS_BADGE"),
      true,
      "the cookie keeps the shell on its target",
    );
  } finally {
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    await Deno.remove(dir, { recursive: true });
  }
});

/** A dev server over `dir` (the unbundled loop unless `unbundled: false`), and its fetcher. */
async function devServer(dir: string, opts: { unbundled?: boolean } = {}) {
  const controller = new AbortController();
  const paths = await resolveProject(dir);
  const port = await new Promise<number>((resolve) => {
    startDevServer({
      paths,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      unbundled: opts.unbundled,
      onListen: ({ port }) => resolve(port),
    });
  });
  return {
    text: async (path: string, headers: Record<string, string> = {}) =>
      await (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).text(),
    stop: async () => {
      controller.abort();
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

const IOS = { cookie: "__denext_platform=ios" };
const pill = (label: string) => `"use client"\nexport function Pill(){ return <i>${label}</i>; }\n`;

/** A Flight page importing its platform modules through the import map (`@/`, `#pill`). */
const ALIAS_FILES = {
  "app/page.tsx": `import { Badge } from "@/components/Badge.tsx";\n` +
    `import { Pill } from "#pill";\n` +
    `export default function Page(){ return <main><Badge/><Pill/></main>; }\n`,
  "components/Badge.tsx": badge("PLAIN_BADGE"),
  "components/Badge.ios.tsx": badge("IOS_BADGE"),
  "components/Pill.tsx": pill("PLAIN_PILL"),
  "components/Pill.ios.tsx": pill("IOS_PILL"),
};
const ALIAS_IMPORTS = { "@/": "./", "#pill": "./components/Pill.tsx" };

for (const unbundled of [true, false]) {
  const loop = unbundled ? "unbundled" : "bundled";
  Deno.test(`denext dev (${loop}): an import-map alias reaches the session's variant in the render and the islands`, async () => {
    const dir = await project(ALIAS_FILES, ALIAS_IMPORTS);
    const dev = await devServer(dir, { unbundled });
    try {
      const html = await dev.text("/?__denext_platform=ios");
      assertStringIncludes(html, "IOS_BADGE", "the server render took Badge.ios.tsx via @/");
      assertStringIncludes(html, "IOS_PILL", "the server render took Pill.ios.tsx via #pill");
      assert(!html.includes("PLAIN_BADGE") && !html.includes("PLAIN_PILL"), html);
      const entry = await dev.text("/_denext/flight.js", IOS);
      // Unbundled: the entry imports each island's file; bundled: each island is a chunk.
      const chunks = [...entry.matchAll(/import\("\.\/([^"]+\.js)"\)/g)].map((c) => c[1]);
      let flight = entry;
      for (const c of chunks) flight += await dev.text(`/_denext/${c}`, IOS);
      const has = (name: string, label: string) => flight.includes(name) || flight.includes(label);
      assert(has("Badge.ios.tsx", "IOS_BADGE"), "the islands carry the iOS Badge");
      assert(has("Pill.ios.tsx", "IOS_PILL"), "the islands carry the iOS Pill");
      assert(!flight.includes("PLAIN_BADGE") && !flight.includes("PLAIN_PILL"));
    } finally {
      await dev.stop();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("denext dev: a platform session's Flight boundary is its own", async () => {
  // The plain Panel is a Server Component; the iOS one is an island. The iOS session renders
  // the route through Flight with Panel.ios.tsx as its island; web keeps no islands.
  const dir = await project({
    "app/page.tsx": `import { Panel } from "../components/Panel.tsx";\n` +
      `export default function Page(){ return <main><Panel/></main>; }\n`,
    "components/Panel.tsx": `export function Panel(){ return <p>PLAIN_PANEL</p>; }\n`,
    "components/Panel.ios.tsx": `"use client"\nimport { useState } from "denext";\n` +
      `export function Panel(){ const [n] = useState(0); return <p>IOS_PANEL{n}</p>; }\n`,
  });
  const dev = await devServer(dir);
  try {
    const ios = await dev.text("/?__denext_platform=ios");
    assertStringIncludes(ios, "IOS_PANEL");
    assertStringIncludes(ios, "/_denext/flight.js", "the iOS route hydrates its islands only");
    const flight = await dev.text("/_denext/flight.js", IOS);
    assertStringIncludes(flight, "Panel.ios.tsx", "the iOS Flight entry carries the iOS island");
    const web = await dev.text("/");
    assertStringIncludes(web, "PLAIN_PANEL");
    assert(!web.includes("/_denext/flight.js"), "web has no island on this route");
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext dev (bundled): a hydrated route's bundle is the session's", async () => {
  const dir = await project({
    "app/page.tsx": `"use client"\nimport { useState } from "denext";\n` +
      `import { label } from "./label.ts";\n` +
      `export default function Page(){ const [n] = useState(0); return <p>{label}{n}</p>; }\n`,
    "app/label.ts": `export const label = "PLAIN_LABEL";\n`,
    "app/label.ios.ts": `export const label = "IOS_LABEL";\n`,
  });
  const dev = await devServer(dir, { unbundled: false });
  try {
    assertStringIncludes(await dev.text("/?__denext_platform=ios"), "IOS_LABEL");
    const ios = await dev.text("/_denext/route.js?p=%2F", IOS);
    assertStringIncludes(ios, "IOS_LABEL", "the iOS route bundle takes label.ios.ts");
    assert(!ios.includes("PLAIN_LABEL"));
    const web = await dev.text("/_denext/route.js?p=%2F");
    assertStringIncludes(web, "PLAIN_LABEL", "web keeps its own cached bundle");
    assert(!web.includes("IOS_LABEL"));
  } finally {
    await dev.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const unbundled of [true, false]) {
  const loop = unbundled ? "unbundled" : "bundled";
  Deno.test(`denext dev (${loop}): a hydrated route's aliases reach the session's files`, async () => {
    // A `"use client"` page imports `tag` by an exact alias and `label` through a plain module
    // that imports it by a prefix alias.
    const dir = await project({
      "app/page.tsx": `"use client"\nimport { useState } from "denext";\n` +
        `import { label } from "@/app/labels.ts";\nimport { tag } from "#tag";\n` +
        `export default function Page(){ const [n] = useState(0); return <p>{label}{tag}{n}</p>; }\n`,
      "app/labels.ts": `export { label } from "@/app/label.ts";\n`,
      "app/label.ts": `export const label = "PLAIN_LABEL";\n`,
      "app/label.mobile.ts": `export const label = "MOBILE_LABEL";\n`,
      "app/tag.ts": `export const tag = "PLAIN_TAG";\n`,
      "app/tag.android.ts": `export const tag = "ANDROID_TAG";\n`,
    }, { "@/": "./", "#tag": "./app/tag.ts" });
    const dev = await devServer(dir, { unbundled });
    try {
      const html = await dev.text("/?__denext_platform=android");
      assertStringIncludes(html, "MOBILE_LABEL");
      assertStringIncludes(html, "ANDROID_TAG");
      // The page's client code, as the session loads it: the unbundled loop's modules, or the
      // bundled route entry.
      const android = { cookie: "__denext_platform=android" };
      const script = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
        .find((src) => src.includes("route.js") || src.includes("@fs") || src.includes("flight"));
      assert(script, html);
      let js = await dev.text(script, android);
      // Follow the unbundled module graph one level at a time (the page imports its modules).
      for (let depth = 0; depth < 4; depth++) {
        const next = [...js.matchAll(/["'](\/_denext\/@fs[^"'?]+(?:\?[^"']*)?)["']/g)].map((m) =>
          m[1]
        );
        for (const url of new Set(next)) js += await dev.text(url, android);
      }
      for (const chunk of [...js.matchAll(/["']\.\/([^"']+\.js)["']/g)].map((m) => m[1])) {
        js += await dev.text(`/_denext/${chunk}`, android);
      }
      assert(js.includes("MOBILE_LABEL") || js.includes("label.mobile.ts"), "label: mobile");
      assert(js.includes("ANDROID_TAG") || js.includes("tag.android.ts"), "tag: android");
      assert(!js.includes("PLAIN_LABEL") && !js.includes("PLAIN_TAG"), "no plain file");
    } finally {
      await dev.stop();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
