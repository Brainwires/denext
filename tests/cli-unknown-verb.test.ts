// When a name nothing claims is worth importing the project's config for. The config's text
// decides; anything it can't see through imports, since a false "no verbs" would silently break a
// project's own verb. Run against each shape a config may be written in; the real plugin verbs
// are the last case.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { readStaticConfig } from "../src/build/config-static.ts";
import { writeCommandCache } from "../src/cli/command-cache.ts";
import { unknownVerbAction } from "../src/cli/unknown-verb.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const VERB = { name: "seed", index: 0 };

/** Run `fn` in a temp directory holding `denext.config.ts` with `source` (none when null). */
async function withConfig(source: string | null, fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_unknown_verb_" });
  try {
    if (source !== null) await Deno.writeTextFile(join(dir, "denext.config.ts"), source);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const DEFINE = 'import { defineConfig } from "denext/server";\n';

const NO_VERBS: Record<string, string> = {
  "an empty default object": "export default {};\n",
  "keys that add no verbs": "export default { compress: false, csp: { frameSrc: [] } };\n",
  "a default typed with satisfies": "export default { compress: false } satisfies object;\n",
  "denext's defineConfig": `${DEFINE}export default defineConfig({ compress: false });\n`,
  "defineConfig from the JSR name":
    'import { defineConfig } from "jsr:@denext/denext@4/server";\nexport default defineConfig({});\n',
  "a factory returning a literal": "export default () => ({ compress: false });\n",
  "a function returning a literal": "export default function () { return { compress: false }; }\n",
  "named exports": "export const compress = false;\nexport const mode = 'spa';\n",
  "a type export beside the default":
    "export type T = string;\nexport interface I {}\nexport default {};\n",
  "`export {}` beside the default": "export {};\nexport default {};\n",
  "a mention in a comment or string": '// plugins\nexport default { title: "commands" };\n',
  "a key nested under another": "export default { spa: { plugins: [], commands: [] } };\n",
};

const MAY_HAVE_VERBS: Record<string, string> = {
  "`commands`": "export default { commands: [] };\n",
  "`plugins`": "export default { plugins: [] };\n",
  "a quoted key": 'export default { "plugins": [] };\n',
  "a shorthand key": "const plugins = [];\nexport default { plugins };\n",
  "a method": "export default { commands() { return []; } };\n",
  "a named `plugins`": "export const plugins = [];\n",
  "a computed key": 'const k = "plugins";\nexport default { [k]: [] };\n',
  "a spread": "const base = {};\nexport default { compress: false, ...base };\n",
  "a variable as the default": "const config = {};\nexport default config;\n",
  "a variable beside a named export": "const c = {};\nexport const a = 1;\nexport default c;\n",
  "a named export beside a default": "export const plugins = [];\nexport default {};\n",
  "another wrapper's call": 'import { withX } from "./x.ts";\nexport default withX({});\n',
  "defineConfig from elsewhere":
    'import { defineConfig } from "./x.ts";\nexport default defineConfig({});\n',
  "defineConfig undeclared": "export default defineConfig({});\n",
  "defineConfig under an alias":
    'import { other as defineConfig } from "denext/server";\nexport default defineConfig({});\n',
  "defineConfig over a variable": `${DEFINE}const c = {};\nexport default defineConfig(c);\n`,
  "defineConfig with a spread argument":
    `${DEFINE}const c = [{}];\nexport default defineConfig(...c);\n`,
  "a second argument": `${DEFINE}export default defineConfig({}, {});\n`,
  "a factory that branches":
    "export default (p) => { if (p) return { plugins: [] }; return {}; };\n",
  "a re-exported default": 'export { default } from "./x.ts";\n',
  "`export * from`": 'export * from "./x.ts";\n',
  "`export { … as … }`": "const p = [];\nexport { p as plugins };\n",
  "two named exports in one statement": "export const a = 1, plugins = [];\n",
  "a destructured export": "export const { plugins } = {};\n",
  "an exported function": "export function plugins() {}\n",
  "CommonJS": "module.exports = { plugins: [] };\n",
  "no exports at all": "globalThis.x = 1;\n",
  "source that doesn't parse": "export default { plugins: [ \n",
};

for (const [name, source] of Object.entries(NO_VERBS)) {
  Deno.test(`no verbs: ${name}`, async () => {
    await withConfig(source, async (dir) => {
      assertEquals(await unknownVerbAction(["seed"], VERB, dir), "unknown");
    });
  });
}

for (const [name, source] of Object.entries(MAY_HAVE_VERBS)) {
  Deno.test(`imports: ${name}`, async () => {
    await withConfig(source, async (dir) => {
      assertEquals(await unknownVerbAction(["seed"], VERB, dir), "discover");
      // Asking about the name never imports, whatever the config says.
      assertEquals(await unknownVerbAction(["seed", "--help"], VERB, dir), "help");
    });
  });
}

Deno.test("no config: nothing to import", async () => {
  await withConfig(null, async (dir) => {
    assertEquals(await unknownVerbAction(["seed"], VERB, dir), "unknown");
    assertEquals(await unknownVerbAction(["seed", "--help"], VERB, dir), "help");
  });
});

Deno.test("--help counts only before `--` and after the verb", async () => {
  await withConfig("export default { commands: [] };\n", async (dir) => {
    assertEquals(await unknownVerbAction(["seed", "x", "-h"], VERB, dir), "help");
    assertEquals(await unknownVerbAction(["seed", "--", "--help"], VERB, dir), "discover");
    assertEquals(
      await unknownVerbAction(["--help", "seed"], { name: "seed", index: 1 }, dir),
      "discover",
    );
  });
});

Deno.test("a fresh listing that names the verb makes it known, --help included", async () => {
  await withConfig("export default {};\n", async (dir) => {
    await writeCommandCache(dir, [{ name: "seed", summary: "s" }]);
    assertEquals(await unknownVerbAction(["seed"], VERB, dir), "discover");
    assertEquals(await unknownVerbAction(["seed", "--help"], VERB, dir), "discover");
    // A listing that doesn't name it, or one gone stale, is no reason to import.
    assertEquals(
      await unknownVerbAction(["biuld"], { name: "biuld", index: 0 }, dir),
      "unknown",
    );
    await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {  };\n");
    assertEquals(await unknownVerbAction(["seed"], VERB, dir), "unknown");
  });
});

Deno.test({
  name: "readStaticConfig: a FIFO or device under the config's name isn't read",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withConfig(null, async (dir) => {
      const path = join(dir, "denext.config.ts");
      const fifo = await new Deno.Command("mkfifo", { args: [path] }).output();
      assertEquals(fifo.code, 0);
      assertEquals((await readStaticConfig(dir)).readable, false);
      await Deno.remove(path);
      await Deno.symlink("/dev/zero", path);
      const device = await readStaticConfig(dir);
      assertEquals([device.readable, device.hidesKeys], [false, true]);
    });
  },
});

Deno.test("readStaticConfig: a config too large to read counts as unreadable", async () => {
  await withConfig(`export default {};\n${"// x\n".repeat(1_700_000)}`, async (dir) => {
    assertEquals((await readStaticConfig(dir)).readable, false);
    assertEquals(await unknownVerbAction(["seed"], VERB, dir), "discover");
  });
});

for (
  const [verb, pkg, make, expected] of [
    [["openapi", "lint"], "openapi", "openapi()", "openapi:"],
    [["content", "list"], "content-collections", "contentCollections()", "content:"],
    [["functions", "list"], "backend", "backend({ functions: {} })", "Edge Functions"],
    [
      ["storage", "ls"],
      "backend",
      'backend({ storage: { driver: { type: "fs" } as never, buckets: {} } })',
      "",
    ],
  ] as const
) {
  Deno.test(`a plugin's verb still runs with the plugin present: ${verb.join(" ")}`, async () => {
    await withConfig(null, async (dir) => {
      const fn = make.slice(0, make.indexOf("("));
      const url = toFileUrl(join(ROOT, "packages", pkg, "mod.ts")).href;
      await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
      await Deno.writeTextFile(
        join(dir, "denext.config.ts"),
        `import { ${fn} } from ${JSON.stringify(url)};\nexport default { plugins: [${make}] };\n`,
      );
      const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--config", join(ROOT, "deno.json"), join(ROOT, "cli.ts"), ...verb],
        cwd: dir,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
      assertEquals(out.includes("unknown command"), false, `exit ${code}: ${out}`);
      assertStringIncludes(out, expected);
    });
  });
}
