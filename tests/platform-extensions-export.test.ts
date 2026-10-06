// Platform-specific files in a platform export: `staticExport(dir, { platform })` resolves
// `Badge.ios.tsx` (etc.) on every build path — the native App Router (`deno bundle` client +
// Deno's loader for the server render), next-compat (esbuild client + SSR bundles) and SPA mode
// (both bundlers) — and leaves the other targets' variants out of the export.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { staticExport } from "../src/build/export.ts";
import { build } from "../src/build/build.ts";
import { startProdServer } from "../src/build/prod-server.ts";
import type { Platform } from "../src/build/platform-extensions.ts";

/** Scaffold a throwaway app in `dir`: a deno.json aliasing `denext` to this checkout + files. */
async function scaffoldApp(dir: string, files: Record<string, string>) {
  const root = new URL("../", import.meta.url).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${root}mod.ts`,
        "denext/jsx-runtime": `${root}src/jsx/jsx-runtime.ts`,
        "denext/server": `${root}src/server/mod.ts`,
        "denext/client": `${root}src/client/mod.ts`,
      },
    }),
  );
  for (const [name, src] of Object.entries(files)) {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, name), src);
  }
}

/** Every `.js` file of the export's client dir, concatenated. */
async function clientJs(outDir: string): Promise<string> {
  const dir = join(outDir, "_denext", "client");
  let js = "";
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".js")) js += await Deno.readTextFile(join(dir, e.name));
  }
  return js;
}

const badge = (label: string) =>
  `"use client"\nimport { useState } from "denext";\n` +
  `export function Badge(){ const [n] = useState(0); return <b>${label}{n}</b>; }\n`;

/** A Flight app: a server page renders a `"use client"` Badge with web/ios/desktop variants. */
const FLIGHT_APP = {
  "app/page.tsx": `import { Badge } from "../components/Badge.tsx";\n` +
    `export default function Page(){ return <main><Badge/></main>; }\n`,
  "components/Badge.tsx": badge("PLAIN_BADGE"),
  "components/Badge.ios.tsx": badge("IOS_BADGE"),
  "components/Badge.desktop.tsx": badge("DESKTOP_BADGE"),
};

const LABELS = ["PLAIN_BADGE", "IOS_BADGE", "DESKTOP_BADGE"];

async function exportFor(platform: Platform, files: Record<string, string>) {
  const dir = await Deno.makeTempDir({ prefix: `denext_platform_${platform}_` });
  await scaffoldApp(dir, files);
  const result = await staticExport(dir, { platform });
  return {
    dir,
    html: await Deno.readTextFile(join(result.outDir, "index.html")),
    js: await clientJs(result.outDir),
    // A platform export names its target for OTA (`_denext/platform.txt`); web carries none.
    stamp: await Deno.readTextFile(join(result.outDir, "_denext", "platform.txt")).catch(() =>
      null
    ),
  };
}

/** Assert `want` (and no other label) is in the export's HTML (when `inHtml`) and client JS. */
function assertOnly(
  got: { html: string; js: string },
  want: string,
  labels: readonly string[],
  inHtml = true,
) {
  if (inHtml) assertStringIncludes(got.html, want, "the server render picked the variant");
  assertStringIncludes(got.js, want, "the client bundle picked the variant");
  for (const other of labels.filter((l) => l !== want)) {
    assert(!got.html.includes(other), `${other} rendered`);
    assert(!got.js.includes(other), `${other} bundled`);
  }
}

for (
  const [platform, want] of [
    ["web", "PLAIN_BADGE"],
    ["ios", "IOS_BADGE"],
    ["android", "PLAIN_BADGE"],
    ["macos", "DESKTOP_BADGE"],
  ] as const
) {
  Deno.test(`staticExport --platform ${platform}: the native path renders and bundles ${want}`, async () => {
    const got = await exportFor(platform, FLIGHT_APP);
    try {
      assertOnly(got, want, LABELS);
      assertEquals(got.stamp, platform === "web" ? null : platform);
    } finally {
      await Deno.remove(got.dir, { recursive: true });
    }
  });
}

/**
 * A hydrated (non-Flight) native route: a `"use client"` page imports `./Label` EXTENSIONLESS
 * (sloppy) and `./Tag.tsx` explicitly; `Label` has only variants (web + mobile), `Tag` a plain
 * file plus an android variant.
 */
const HYDRATED_APP = {
  "app/page.tsx": `"use client"\nimport { useState } from "denext";\n` +
    `import { label } from "./Label";\nimport { tag } from "./Tag.tsx";\n` +
    `export default function Page(){ const [n] = useState(0); return <p>{label}{tag}{n}</p>; }\n`,
  "app/Label.web.ts": `export const label = "WEB_LABEL";\n`,
  "app/Label.mobile.ts": `export const label = "MOBILE_LABEL";\n`,
  "app/Tag.tsx": `export const tag = "PLAIN_TAG";\n`,
  "app/Tag.android.tsx": `export const tag = "ANDROID_TAG";\n`,
};

for (
  const [platform, label, tag] of [
    ["web", "WEB_LABEL", "PLAIN_TAG"],
    ["ios", "MOBILE_LABEL", "PLAIN_TAG"],
    ["android", "MOBILE_LABEL", "ANDROID_TAG"],
    ["linux", "WEB_LABEL", "PLAIN_TAG"],
  ] as const
) {
  Deno.test(`staticExport --platform ${platform}: a hydrated route resolves ${label} + ${tag}`, async () => {
    const got = await exportFor(platform, HYDRATED_APP);
    try {
      assertOnly(got, label, ["WEB_LABEL", "MOBILE_LABEL"]);
      assertOnly(got, tag, ["PLAIN_TAG", "ANDROID_TAG"]);
    } finally {
      await Deno.remove(got.dir, { recursive: true });
    }
  });
}

Deno.test("staticExport: a module with no file for the target fails naming its variants", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_gap_" });
  try {
    await scaffoldApp(dir, {
      "app/page.tsx": `import { Pad } from "./Pad.tsx";\n` +
        `export default function Page(){ return <Pad/>; }\n`,
      "app/Pad.ios.tsx": `export function Pad(){ return <i>IOS</i>; }\n`,
      "app/Pad.android.tsx": `export function Pad(){ return <i>ANDROID</i>; }\n`,
    });
    const err = await assertRejects(() => staticExport(dir, { platform: "macos" }));
    assertStringIncludes(
      (err as Error).message,
      "`./app/Pad.tsx` has `.android` and `.ios` variants but none for macos: add `Pad.tsx` " +
        "or `Pad.macos.tsx`",
    );
    // The targets that have one export fine.
    const ok = await staticExport(dir, { platform: "ios" });
    assertStringIncludes(await Deno.readTextFile(join(ok.outDir, "index.html")), "IOS");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("staticExport: `platformExtensions: false` resolves the plain files only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_off_" });
  try {
    await scaffoldApp(dir, {
      ...FLIGHT_APP,
      "denext.config.ts": `export default { platformExtensions: false };\n`,
    });
    const result = await staticExport(dir, { platform: "ios" });
    const got = {
      html: await Deno.readTextFile(join(result.outDir, "index.html")),
      js: await clientJs(result.outDir),
    };
    assertOnly(got, "PLAIN_BADGE", LABELS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext build + start: the web target's `.web` variant reaches the bundle and the render", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_build_" });
  const controller = new AbortController();
  try {
    await scaffoldApp(dir, {
      ...FLIGHT_APP,
      "components/Badge.web.tsx": badge("WEB_BADGE"),
    });
    await build(dir);
    const clientDir = join(dir, ".denext", "client");
    let js = "";
    for await (const e of Deno.readDir(clientDir)) {
      if (e.isFile && e.name.endsWith(".js")) {
        js += await Deno.readTextFile(join(clientDir, e.name));
      }
    }
    assertStringIncludes(js, "WEB_BADGE");
    for (const other of LABELS) assert(!js.includes(other), `${other} bundled`);

    const port = await new Promise<number>((resolve, reject) => {
      startProdServer({
        projectDir: dir,
        port: 0,
        hostname: "127.0.0.1",
        signal: controller.signal,
        onListen: ({ port }) => resolve(port),
      }).catch(reject);
    });
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assertStringIncludes(html, "WEB_BADGE", "the server render picked the .web variant");
    assert(!html.includes("PLAIN_BADGE"));
  } finally {
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    await Deno.remove(dir, { recursive: true });
  }
});
