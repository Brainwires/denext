// `denext migrate`'s next-intl request-config wiring (src/build/next-intl-migrate.ts): the
// request config `createNextIntlPlugin` names is imported from each root layout.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { wireNextIntlRequestConfig } from "../src/build/next-intl-migrate.ts";

const DEPS = { next: "15.3.0", "next-intl": "4.0.0" };
const LAYOUT = "export default function L({ children }) { return children; }\n";

async function withApp(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_intl_migrate_" }));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("next-intl migrate: an unevaluated config's plugin import wires the default request config", async () => {
  await withApp({
    "next.config.js": 'const p = require("next-intl/plugin");\nmodule.exports = p()({});\n',
    "i18n/request.ts": "export default {};\n",
    "app/layout.tsx": '"use strict";\n' + LAYOUT,
  }, async (dir) => {
    const written: string[] = [];
    const info = await wireNextIntlRequestConfig(
      dir,
      DEPS,
      { file: "next.config.js", plugins: null },
      written,
    );
    assertEquals(info, { requestConfig: "i18n/request.ts", wired: ["app/layout.tsx"], notes: [] });
    assertEquals(written, [join(dir, "app/layout.tsx")]);
    const layout = await Deno.readTextFile(join(dir, "app/layout.tsx"));
    assert(layout.startsWith('"use strict";\nimport "../i18n/request";'), layout);
  });
});

Deno.test("next-intl migrate: every route group's root layout is wired", async () => {
  await withApp({
    "next.config.mjs": "",
    "src/i18n/request.tsx": "export default {};\n",
    "src/app/(shop)/layout.tsx": LAYOUT,
    "src/app/(shop)/nested/layout.tsx": LAYOUT,
    "src/app/(blog)/[locale]/layout.jsx": LAYOUT,
    "src/app/_components/layout.tsx": LAYOUT,
  }, async (dir) => {
    const info = await wireNextIntlRequestConfig(
      dir,
      DEPS,
      { file: "next.config.mjs", plugins: [{ name: "next-intl/plugin" }] },
      [],
    );
    assertEquals(info?.wired, ["src/app/(blog)/[locale]/layout.jsx", "src/app/(shop)/layout.tsx"]);
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "src/app/(blog)/[locale]/layout.jsx")),
      'import "../../../i18n/request";',
    );
    assertEquals(await Deno.readTextFile(join(dir, "src/app/(shop)/nested/layout.tsx")), LAYOUT);
    assertEquals(await Deno.readTextFile(join(dir, "src/app/_components/layout.tsx")), LAYOUT);
  });
});

Deno.test("next-intl migrate: no plugin, no next-intl or a missing request config", async () => {
  await withApp({ "next.config.mjs": "", "app/layout.tsx": LAYOUT }, async (dir) => {
    const next = { file: "next.config.mjs", plugins: [] };
    assertEquals(await wireNextIntlRequestConfig(dir, DEPS, next, []), undefined);
    const withPlugin = { file: "next.config.mjs", plugins: [{ name: "next-intl/plugin" }] };
    assertEquals(await wireNextIntlRequestConfig(dir, { next: "15" }, withPlugin, []), undefined);
    const missing = await wireNextIntlRequestConfig(dir, DEPS, withPlugin, []);
    assertEquals(missing?.requestConfig, null);
    assertStringIncludes(missing!.notes[0], "was not found");
    // A path out of the project is never followed.
    const outside = await wireNextIntlRequestConfig(dir, DEPS, {
      file: "next.config.mjs",
      plugins: [{ name: "next-intl/plugin", arg: { requestConfig: "../../etc/hosts" } }],
    }, []);
    assertEquals(outside?.requestConfig, null);
    assertEquals(await Deno.readTextFile(join(dir, "app/layout.tsx")), LAYOUT);
  });
});
