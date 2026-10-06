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

async function project(files: Record<string, string>): Promise<string> {
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
