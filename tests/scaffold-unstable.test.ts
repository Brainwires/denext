// The `unstable` list a generated `deno.json` carries: `no-legacy-abort` in every `denext create`
// template and every `denext migrate` config, so `deno` runs Deno.serve without the legacy
// request abort (and its notice) whatever starts it — a least-privilege `start` task included,
// which cannot re-run itself with the flag. A list already there is merged, never replaced.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  DENEXT_UNSTABLE,
  denoJson,
  SCAFFOLD_TEMPLATES,
  scaffoldFiles,
  withDenextUnstable,
} from "../src/build/scaffold.ts";
import { migrateProject } from "../packages/migrate/src/migrate.ts";
import { FEATURES } from "../src/cli/commands/create.ts";

Deno.test("withDenextUnstable: the existing entries, then the writer's, then denext's, each once", () => {
  assertEquals(DENEXT_UNSTABLE, ["no-legacy-abort"]);
  assertEquals(withDenextUnstable(undefined), ["no-legacy-abort"]);
  assertEquals(withDenextUnstable(undefined, ["sloppy-imports"]), [
    "sloppy-imports",
    "no-legacy-abort",
  ]);
  assertEquals(withDenextUnstable(["kv", "no-legacy-abort"], ["sloppy-imports"]), [
    "kv",
    "no-legacy-abort",
    "sloppy-imports",
  ]);
  // Not a list of strings: nothing of it survives (it was never a valid `unstable`).
  assertEquals(withDenextUnstable("kv"), ["no-legacy-abort"]);
  assertEquals(withDenextUnstable(["kv", 3, null]), ["kv", "no-legacy-abort"]);
});

Deno.test("every denext create template, with every feature, writes unstable: [no-legacy-abort]", () => {
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
      assertEquals(config.unstable, ["no-legacy-abort"], `${template} ${JSON.stringify(features)}`);
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

Deno.test("denext migrate writes no-legacy-abort beside sloppy-imports, and a re-run keeps added entries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_unstable_migrate_" });
  try {
    await viteApp(dir);
    await migrateProject(dir);
    const path = join(dir, "deno.json");
    const first = JSON.parse(await Deno.readTextFile(path));
    assertEquals(first.unstable, ["sloppy-imports", "no-legacy-abort"]);
    // The user adds a feature to the generated file; migrating again keeps it.
    first.unstable.push("kv");
    await Deno.writeTextFile(path, JSON.stringify(first, null, 2) + "\n");
    await migrateProject(dir);
    const second = JSON.parse(await Deno.readTextFile(path));
    assertEquals(second.unstable, ["sloppy-imports", "no-legacy-abort", "kv"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
