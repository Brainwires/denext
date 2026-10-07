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
async function scaffoldApp(
  dir: string,
  files: Record<string, string>,
  imports: Record<string, string> = {},
) {
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
        ...imports,
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

async function exportFor(
  platform: Platform,
  files: Record<string, string>,
  imports: Record<string, string> = {},
) {
  const dir = await Deno.makeTempDir({ prefix: `denext_platform_${platform}_` });
  await scaffoldApp(dir, files, imports);
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
 * The Flight app, importing its platform modules through the app's `deno.json` import map: the
 * Next-style `@/` prefix and an exact alias. The alias resolves first, then the target's variant
 * applies to the file it names, in the server render and the client bundle alike.
 */
const ALIAS_IMPORTS = { "@/": "./", "#pill": "./components/Pill.tsx" };
const pill = (label: string) => `"use client"\nexport function Pill(){ return <i>${label}</i>; }\n`;
const ALIAS_APP = {
  ...FLIGHT_APP,
  "app/page.tsx": `import { Badge } from "@/components/Badge.tsx";\n` +
    `import { Pill } from "#pill";\n` +
    `export default function Page(){ return <main><Badge/><Pill/></main>; }\n`,
  "components/Pill.tsx": pill("PLAIN_PILL"),
  "components/Pill.ios.tsx": pill("IOS_PILL"),
  "components/Pill.desktop.tsx": pill("DESKTOP_PILL"),
};
const PILLS = ["PLAIN_PILL", "IOS_PILL", "DESKTOP_PILL"];

// In this process (whose import map is denext's own) an alias resolves only through the copies
// the server loader writes, which is the path under test; `web` (no copies) runs through the
// CLI below.
for (
  const [platform, badgeWant, pillWant] of [
    ["ios", "IOS_BADGE", "IOS_PILL"],
    ["macos", "DESKTOP_BADGE", "DESKTOP_PILL"],
  ] as const
) {
  Deno.test(`staticExport --platform ${platform}: an import-map alias renders and bundles ${badgeWant} + ${pillWant}`, async () => {
    const got = await exportFor(platform, ALIAS_APP, ALIAS_IMPORTS);
    try {
      assertOnly(got, badgeWant, LABELS);
      assertOnly(got, pillWant, PILLS);
    } finally {
      await Deno.remove(got.dir, { recursive: true });
    }
  });
}

/**
 * `denext export --platform <target>` as a user runs it: a CLI process with the app's import map
 * (from a source checkout the CLI re-execs with the app's config merged in, which a manual
 * `node_modules` asks for; a JSR install gets it from `deno task`).
 */
async function cliExport(platform: Platform, files: Record<string, string>) {
  const dir = await Deno.makeTempDir({ prefix: `denext_platform_cli_${platform}_` });
  await scaffoldApp(dir, files, ALIAS_IMPORTS);
  const config = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ ...config, nodeModulesDir: "manual" }),
  );
  const cli = new URL("../cli.ts", import.meta.url).href;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", cli, "export", "--platform", platform, dir],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, log);
  const outDir = join(dir, "out");
  return {
    dir,
    html: await Deno.readTextFile(join(outDir, "index.html")),
    js: await clientJs(outDir),
  };
}

for (
  const [platform, badgeWant, pillWant] of [
    ["web", "PLAIN_BADGE", "PLAIN_PILL"],
    ["ios", "IOS_BADGE", "IOS_PILL"],
  ] as const
) {
  Deno.test(`denext export --platform ${platform} (CLI): an import-map alias renders and bundles ${badgeWant} + ${pillWant}`, async () => {
    const got = await cliExport(platform, ALIAS_APP);
    try {
      assertOnly(got, badgeWant, LABELS);
      assertOnly(got, pillWant, PILLS);
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

/**
 * The hydrated route through the import map: the `"use client"` page imports `Tag` by an alias,
 * and `Label` through a plain module (`@/app/labels.ts`) that imports it by an alias in turn, so
 * the client bundle (where Deno resolves an alias itself) needs both importers rewritten.
 */
const HYDRATED_ALIAS_APP = {
  ...HYDRATED_APP,
  "app/page.tsx": `"use client"\nimport { useState } from "denext";\n` +
    `import { label } from "@/app/labels.ts";\nimport { tag } from "#tag";\n` +
    `export default function Page(){ const [n] = useState(0); return <p>{label}{tag}{n}</p>; }\n`,
  "app/labels.ts": `export { label } from "@/app/Label";\n`,
};

for (
  const [platform, label, tag] of [
    ["ios", "MOBILE_LABEL", "PLAIN_TAG"],
    ["android", "MOBILE_LABEL", "ANDROID_TAG"],
  ] as const
) {
  Deno.test(`staticExport --platform ${platform}: a hydrated route's aliases resolve ${label} + ${tag}`, async () => {
    const got = await exportFor(platform, HYDRATED_ALIAS_APP, {
      "@/": "./",
      "#tag": "./app/Tag.tsx",
    });
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

Deno.test("denext build + start: start renders the build's server copies from a read-only .denext", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_platform_readonly_" });
  const controller = new AbortController();
  const outDir = join(dir, ".denext");
  try {
    await scaffoldApp(dir, {
      ...FLIGHT_APP,
      "denext.config.ts": `export default { cacheComponents: true };\n`,
      "app/page.tsx": `import { Badge } from "../components/Badge.tsx";\n` +
        `import { stamp } from "../lib/stamp.ts";\n` +
        `export default async function Page(){ return <main><Badge/>{await stamp()}</main>; }\n`,
      "lib/stamp.ts": `export async function stamp() { "use cache"; return "CACHED_STAMP"; }\n`,
      "components/Badge.web.tsx": badge("WEB_BADGE"),
    });
    await build(dir);
    // Nothing under .denext may be written from here on.
    const walkDirs = async (p: string, mode: number) => {
      for await (const e of Deno.readDir(p)) {
        if (e.isDirectory) await walkDirs(join(p, e.name), mode);
      }
      await Deno.chmod(p, mode);
    };
    await walkDirs(outDir, 0o555);
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
    assertStringIncludes(html, "WEB_BADGE", "the server render took the .web variant");
    assertStringIncludes(html, "CACHED_STAMP");
    assert(!html.includes("PLAIN_BADGE"));
    const entries = await Array.fromAsync(Deno.readDir(outDir), (e) => e.name);
    assert(!entries.includes("server-cache"), "start compiled nothing");
    const manifest = JSON.parse(await Deno.readTextFile(join(outDir, "manifest.json")));
    assertEquals(
      manifest.serverCopies.redirects["components/Badge.tsx"],
      "components/Badge.web.tsx",
    );
    assert(manifest.serverCopies.copies["app/page.tsx"], "the page's copy was compiled at build");
  } finally {
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    const restore = async (p: string) => {
      await Deno.chmod(p, 0o755).catch(() => {});
      for await (const e of Deno.readDir(p)) if (e.isDirectory) await restore(join(p, e.name));
    };
    await restore(outDir).catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
});
