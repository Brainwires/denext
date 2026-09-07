// `denext migrate` on a React Router v7 framework-mode app (`app/routes.ts` config routing):
// the app's SOURCE is untouched — migrate writes a deno.json aliasing the RR toolchain to the
// denext runtimes and a denext.config.ts registering the @denext/react-router plugin. Contrast
// the Remix v2 path (tests/migrate-remix.test.ts), which physically transforms `app/routes/`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { migrateProject } from "../src/build/migrate.ts";

async function writeRr7App(dir: string): Promise<string> {
  const app = join(dir, "app");
  await Deno.mkdir(join(app, "routes"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "rr7-app",
      type: "module",
      dependencies: {
        "react": "^19",
        "react-dom": "^19",
        "react-router": "^7",
        "@react-router/node": "^7",
        "@react-router/serve": "^7",
      },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "react-router.config.ts"),
    `export default { ssr: true, appDirectory: "app" };\n`,
  );
  await Deno.writeTextFile(
    join(app, "routes.ts"),
    `import { index, route } from "@react-router/dev/routes";\n` +
      `export default [index("routes/home.tsx"), route("about", "routes/about.tsx")];\n`,
  );
  await Deno.writeTextFile(
    join(app, "root.tsx"),
    `export default function Root() { return null; }\n`,
  );
  await Deno.writeTextFile(
    join(app, "routes", "home.tsx"),
    `export default function Home() { return null; }\n`,
  );
  await Deno.writeTextFile(
    join(app, "routes", "about.tsx"),
    `export default function About() { return null; }\n`,
  );
  return app;
}

Deno.test("migrate: an RR7 framework app takes the plugin path (sources untouched, deno.config + aliases written)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "denext_rr7_migrate_" });
  try {
    const app = await writeRr7App(tmp);
    const before = await Deno.readTextFile(join(app, "routes.ts"));
    const r = await migrateProject(tmp);
    assertEquals(r.kind, "remix");
    assert(!r.remix, "no route-tree transform report — the plugin path does not transform sources");

    // The app's own routes.ts is byte-identical (no --codemod): the plugin reads it at build time.
    assertEquals(await Deno.readTextFile(join(app, "routes.ts")), before);
    assert(await exists(join(app, "routes", "home.tsx")), "route files stay in place");

    const config = await Deno.readTextFile(join(tmp, "denext.config.ts"));
    assertStringIncludes(config, `import { reactRouter } from "@denext/react-router";`);
    assertStringIncludes(config, "plugins: [reactRouter()]");

    const deno = JSON.parse(await Deno.readTextFile(join(tmp, "deno.json")));
    const imp = deno.imports as Record<string, string>;
    assertStringIncludes(imp["@react-router/dev/routes"], "@denext/react-router");
    assertStringIncludes(imp["@denext/react-router"], "jsr:@denext/react-router@");
    assertStringIncludes(imp["react-router"], "/remix");
    assertStringIncludes(imp["react-router/dom"], "@denext/react-router");
    assertStringIncludes(imp["react-router/dom"], "/dom");
    assertStringIncludes(imp["@react-router/node"], "/remix/server");
    // The RR server adapters are dropped as npm deps (their behavior is denext's).
    assert(!("@react-router/serve" in imp));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("migrate: a Remix v2 flat-file app still takes the transform path (not the plugin)", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "denext_remix_v2_" });
  try {
    const app = join(tmp, "app");
    await Deno.mkdir(join(app, "routes"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "package.json"),
      JSON.stringify({
        name: "remix-app",
        dependencies: { "@remix-run/react": "^2", "@remix-run/node": "^2" },
      }),
    );
    await Deno.writeTextFile(
      join(app, "root.tsx"),
      `export default function Root() { return null; }\n`,
    );
    await Deno.writeTextFile(
      join(app, "routes", "_index.tsx"),
      `export default function Home() { return null; }\n`,
    );
    const r = await migrateProject(tmp);
    assertEquals(r.kind, "remix");
    assert(r.remix, "the v2 flat-file path transforms the tree");
    const config = await Deno.readTextFile(join(tmp, "denext.config.ts"));
    assert(!config.includes("reactRouter()"), "no react-router plugin for a @remix-run app");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
