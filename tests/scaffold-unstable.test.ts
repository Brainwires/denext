// The `unstable` list a generated `deno.json` carries. denext 5.0 runs only on runtimes where
// Deno.serve's no-legacy-abort behavior is the default, so `"no-legacy-abort"` is retired: no
// `denext create` template writes it, and `denext migrate` drops it from a config it rewrites while
// keeping every other entry (a list already there is merged, never replaced).

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  denoJson,
  RETIRED_UNSTABLE,
  SCAFFOLD_TEMPLATES,
  scaffoldFiles,
  withDenextUnstable,
} from "../src/build/scaffold.ts";
import { migrateProject } from "../src/build/migrate.ts";
import { freshDenoJson } from "../src/build/migrate-fresh.ts";
import { FEATURES } from "../src/cli/commands/create.ts";

Deno.test("withDenextUnstable: the existing entries, then the writer's, each once, minus retired ones", () => {
  assertEquals(RETIRED_UNSTABLE, ["no-legacy-abort"]);
  assertEquals(withDenextUnstable(undefined), []);
  assertEquals(withDenextUnstable(undefined, ["sloppy-imports"]), ["sloppy-imports"]);
  assertEquals(withDenextUnstable(["kv", "no-legacy-abort"], ["sloppy-imports"]), [
    "kv",
    "sloppy-imports",
  ]);
  assertEquals(withDenextUnstable(["no-legacy-abort"]), []);
  // Not a list of strings: nothing of it survives (it was never a valid `unstable`).
  assertEquals(withDenextUnstable("kv"), []);
  assertEquals(withDenextUnstable(["kv", 3, null]), ["kv"]);
});

Deno.test("no denext create template, with any feature, writes an unstable list", () => {
  const variants: Record<string, boolean>[] = [
    {},
    ...FEATURES.map((f) => ({ [f.key === "compatibility" ? "compatibilityMode" : f.key]: true })),
    Object.fromEntries(
      FEATURES.map((f) => [f.key === "compatibility" ? "compatibilityMode" : f.key, true]),
    ),
  ];
  for (const template of SCAFFOLD_TEMPLATES) {
    for (const features of variants) {
      const opts = { dir: ".", template, ...features };
      const files = scaffoldFiles(opts);
      const file = files.find((f) => f.path === "deno.json");
      const config = JSON.parse(file?.content ?? denoJson(opts));
      assertEquals(config.unstable, undefined, `${template} ${JSON.stringify(features)}`);
    }
  }
});

/** A minimal Vite React SPA for `migrateProject`. */
async function viteApp(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "web", dependencies: { react: "^19", "react-dom": "^19" } }),
  );
  await Deno.writeTextFile(join(dir, "vite.config.ts"), "export default {};\n");
  await Deno.writeTextFile(
    join(dir, "index.html"),
    `<!doctype html><html><body><div id="root"></div>` +
      `<script type="module" src="/src/main.tsx"></script></body></html>`,
  );
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(join(dir, "src", "main.tsx"), "export {};\n");
}

Deno.test("denext migrate writes sloppy-imports only, and a re-run drops no-legacy-abort but keeps added entries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_unstable_migrate_" });
  try {
    await viteApp(dir);
    await migrateProject(dir);
    const path = join(dir, "deno.json");
    const first = JSON.parse(await Deno.readTextFile(path));
    assertEquals(first.unstable, ["sloppy-imports"]);
    // A config from a pre-5.0 migrate (with the retired entry) the user added a feature to:
    // migrating again keeps the feature and drops the retired entry.
    first.unstable.push("no-legacy-abort", "kv");
    await Deno.writeTextFile(path, JSON.stringify(first, null, 2) + "\n");
    await migrateProject(dir);
    const second = JSON.parse(await Deno.readTextFile(path));
    assertEquals(second.unstable, ["sloppy-imports", "kv"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext migrate (Fresh): a deno.json whose only unstable entry is retired loses the key", () => {
  const config = { unstable: ["no-legacy-abort"], tasks: {}, imports: {} };
  const out = freshDenoJson(config, {
    marker: "m",
    imports: {},
    tasks: {},
    unstable: withDenextUnstable(config.unstable),
  });
  assertEquals("unstable" in out, false);
  const kept = freshDenoJson({ ...config, unstable: ["kv", "no-legacy-abort"] }, {
    marker: "m",
    imports: {},
    tasks: {},
    unstable: withDenextUnstable(["kv", "no-legacy-abort"]),
  });
  assertEquals(kept.unstable, ["kv"]);
});
