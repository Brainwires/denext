import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { serveMetadataFile } from "../src/server/metadata-files.ts";
import { createApp } from "../src/server/app.ts";
import { defaultLoader } from "../src/server/mod.ts";

async function appWith(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_icons_" });
  const appDir = join(dir, "app");
  await Deno.mkdir(appDir);
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(join(appDir, name), content);
  }
  return appDir;
}

Deno.test("scanRoutes detects icon / apple-icon / twitter-image (apple-icon not misread as icon)", async () => {
  const appDir = await appWith({
    "page.tsx": "export default function P(){ return null }",
    "icon.png": "PNG",
    "apple-icon.png": "PNG",
    "twitter-image.tsx": "export default function TW(){ return null }",
  });
  try {
    const m = await scanRoutes(appDir);
    assertEquals(m.icon, join(appDir, "icon.png"));
    assertEquals(m.appleIcon, join(appDir, "apple-icon.png"));
    assertEquals(m.twitterImage, join(appDir, "twitter-image.tsx"));
  } finally {
    await Deno.remove(appDir.replace(/\/app$/, ""), { recursive: true });
  }
});

Deno.test("serveMetadataFile serves a static icon with a content-type", async () => {
  const appDir = await appWith({
    "page.tsx": "export default function P(){ return null }",
    "icon.png": "\x89PNG\r\n",
  });
  try {
    const m = await scanRoutes(appDir);
    const res = await serveMetadataFile(m, "/icon", defaultLoader);
    assert(res, "expected an icon response");
    assertEquals(res!.status, 200);
    assertStringIncludes(res!.headers.get("content-type") ?? "", "image/");
  } finally {
    await Deno.remove(appDir.replace(/\/app$/, ""), { recursive: true });
  }
});

Deno.test("a root icon file auto-injects <link rel=icon> into the page head", async () => {
  const appDir = await appWith({
    "page.tsx": "export default function P(){ return null }",
    "icon.png": "PNG",
    "apple-icon.png": "PNG",
  });
  try {
    const manifest = await scanRoutes(appDir);
    const app = createApp({ getManifest: () => manifest, load: defaultLoader });
    const html = await (await app(new Request("http://localhost/"))).text();
    assertStringIncludes(html, `<link rel="icon" href="/icon">`);
    assertStringIncludes(html, `<link rel="apple-touch-icon" href="/apple-icon">`);
  } finally {
    await Deno.remove(appDir.replace(/\/app$/, ""), { recursive: true });
  }
});
