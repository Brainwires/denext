// Generated copies of an app's deno.json (the `deno bundle` temp dir, .denext/module-config.json,
// .denext/css-config.json) keep its `links` pointing at the same directories.

import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { carryLinks, rebaseLinks } from "../src/build/config-links.ts";

const root = resolve("/proj");

Deno.test("rebaseLinks: a relative entry is re-based for the copy's directory", () => {
  const app = join(root, "app");
  assertEquals(rebaseLinks(["../vendor/pkg"], app, join(app, ".denext")), ["../../vendor/pkg"]);
  assertEquals(rebaseLinks(["./local"], app, join(root, "tmp", "b")), ["../../app/local"]);
});

Deno.test("rebaseLinks: nothing to carry is undefined; non-strings are dropped", () => {
  assertEquals(rebaseLinks(undefined, root, root), undefined);
  assertEquals(rebaseLinks([], root, root), undefined);
  assertEquals(rebaseLinks([1, null, "x"], root, root), ["x"]);
});

Deno.test("carryLinks: links and the legacy patch key ride along; a stale key is removed", () => {
  const target: Record<string, unknown> = { links: ["stale"] };
  carryLinks(target, { patch: ["../p"] }, join(root, "app"), join(root, "app", "out"));
  assertEquals(target, { patch: ["../../p"] });
});

Deno.test("carryLinks: a copied config resolves the linked package from its new directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_links_" });
  try {
    // A local JSR package `@t/linked`, linked from the app, imported through the app's map.
    await Deno.mkdir(join(dir, "linked"));
    await Deno.writeTextFile(
      join(dir, "linked", "deno.json"),
      JSON.stringify({ name: "@t/linked", version: "1.0.0", exports: "./mod.ts" }),
    );
    await Deno.writeTextFile(join(dir, "linked", "mod.ts"), "export const v = 42;\n");
    const app = join(dir, "app");
    await Deno.mkdir(app);
    const appCfg = { links: ["../linked"], imports: { "@t/linked": "jsr:@t/linked@^1" } };
    const copyDir = join(dir, "elsewhere", "deep");
    await Deno.mkdir(copyDir, { recursive: true });
    const copy: Record<string, unknown> = { ...appCfg };
    carryLinks(copy, appCfg, app, copyDir);
    const cfg = join(copyDir, "deno.json");
    await Deno.writeTextFile(cfg, JSON.stringify(copy));
    await Deno.writeTextFile(
      join(copyDir, "main.ts"),
      'import { v } from "@t/linked";\nconsole.log(v);\n',
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", cfg, join(copyDir, "main.ts")],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      new TextDecoder().decode(out.stdout).trim(),
      "42",
      new TextDecoder().decode(out.stderr),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
