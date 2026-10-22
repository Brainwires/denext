// A project or framework checkout named through a symlink (macOS `/var` → `/private/var`, a
// symlinked home or workspace folder) must classify its modules the way its real path does: the
// build-time feature scans read only the app's own sources, never the framework's.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { canonicalPath } from "../src/build/canonical-path.ts";
import { isFrameworkSource, localModulesOutside } from "../src/build/module-graph.ts";

const REPO = dirname(fromFileUrl(new URL("../deno.json", import.meta.url)));

/**
 * A fresh temp dir holding a symlink `link` to `target`, or `null` when this host can't create
 * one: the test then logs why it skips. On Windows it is a junction, which needs no privilege.
 */
async function symlinkTo(target: string): Promise<{ dir: string; link: string } | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext-symlink-" });
  const link = join(dir, "link");
  try {
    await Deno.symlink(target, link, { type: "junction" });
  } catch (err) {
    await Deno.remove(dir, { recursive: true });
    console.warn(`skipped: this host can't create a directory symlink (${err})`);
    return null;
  }
  return { dir, link };
}

Deno.test("canonicalPath resolves a symlink and normalises a path that does not exist", async () => {
  const made = await symlinkTo(REPO);
  if (!made) return;
  try {
    assertEquals(
      canonicalPath(join(made.link, "deno.json")),
      Deno.realPathSync(REPO + "/deno.json"),
    );
    // A path that does not exist resolves through its nearest existing ancestor.
    const missing = join(made.link, "src", "a", "..", "b", "missing");
    assertEquals(canonicalPath(missing), join(Deno.realPathSync(REPO), "src", "b", "missing"));
    assertEquals(
      canonicalPath(join(made.dir, "nope", "x.ts")),
      join(Deno.realPathSync(made.dir), "nope", "x.ts"),
    );
  } finally {
    await Deno.remove(made.dir, { recursive: true });
  }
});

Deno.test("isFrameworkSource recognises the framework's source through a symlinked checkout", async () => {
  const made = await symlinkTo(REPO);
  if (!made) return;
  try {
    assertEquals(isFrameworkSource(join(made.link, "src/compat/react.ts")), true);
    assertEquals(isFrameworkSource(join(made.link, "mod.ts")), true);
    assertEquals(isFrameworkSource(join(made.link, "examples/hello/app/page.tsx")), false);
  } finally {
    await Deno.remove(made.dir, { recursive: true });
  }
});

Deno.test("localModulesOutside: a project reached through a symlink keeps its own modules inside", async () => {
  const root = await Deno.makeTempDir({ prefix: "denext-outside-" });
  try {
    const app = join(root, "app");
    const shared = join(root, "shared");
    await Deno.mkdir(join(app, "app"), { recursive: true });
    await Deno.mkdir(shared);
    await Deno.writeTextFile(join(shared, "ui.ts"), "export const ui = 1;\n");
    await Deno.writeTextFile(join(app, "app", "helper.ts"), "export const helper = 2;\n");
    await Deno.writeTextFile(
      join(app, "app", "page.tsx"),
      'import { helper } from "./helper.ts";\nimport { ui } from "../../shared/ui.ts";\n' +
        "export default () => helper + ui;\n",
    );
    let link: string;
    try {
      link = join(root, "link");
      await Deno.symlink(app, link, { type: "junction" });
    } catch (err) {
      console.warn(`skipped: this host can't create a directory symlink (${err})`);
      return;
    }
    const real = Deno.realPathSync(app);
    for (const projectDir of [app, link, real]) {
      for (const pageDir of [app, link, real]) {
        const outside = await localModulesOutside(projectDir, [{
          filePath: join(pageDir, "app", "page.tsx"),
          layoutChain: [],
          templateChain: [],
        }]);
        assertEquals(
          outside.map(canonicalPath),
          [canonicalPath(join(shared, "ui.ts"))],
          `project ${projectDir}, page ${pageDir}`,
        );
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("localModulesOutside warns and scans the project alone when the graph can't be crawled", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const outside = await localModulesOutside("/nowhere", [{
      filePath: "\0not a path",
      layoutChain: [],
      templateChain: [],
    }]);
    assertEquals(outside, []);
  } finally {
    console.warn = warn;
  }
  assertEquals(warnings.length, 1, warnings.join("\n"));
  assertStringIncludes(warnings[0], "build-time feature scans");
  assert(warnings[0].includes("/nowhere"));
});
