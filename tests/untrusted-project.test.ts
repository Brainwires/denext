// What the inspecting verbs do with a project nobody has decided to trust: they read it, and none
// of its code runs. Each case runs against a hostile fixture whose `denext.config.ts` leaves a
// marker when imported. `denext commands` is the control: it imports the config on purpose.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { collectRoutes } from "../src/build/route-list.ts";
import { generateArtifact } from "../src/build/generate.ts";
import { resolveProject, resolveProjectLayout } from "../src/build/paths.ts";
import { readStaticConfig } from "../src/build/config-static.ts";
import { denoCacheDir } from "../src/build/deno-cache-dir.ts";
import { routeMap } from "../src/mcp/inspect.ts";
import { projectLaunchPolicy } from "../src/cli/commands/desktop-doctor.ts";
import { ensureCodeIndex } from "../src/mcp/rag/codebase.ts";

const CLI = new URL("../cli.ts", import.meta.url).href;

/** A project whose config marks `marker` when imported, and which has a page. */
async function hostile(configBody = "export default {};\n"): Promise<{
  dir: string;
  marker: string;
  ran: () => Promise<boolean>;
}> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext-hostile-" }));
  const marker = join(dir, "..", `${dir.split(/[\\/]/).pop()}.marker`);
  await Deno.mkdir(join(dir, "app"));
  await Deno.writeTextFile(join(dir, "app", "page.tsx"), "export default () => null;\n");
  await Deno.writeTextFile(join(dir, "deno.json"), "{}\n");
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `Deno.writeTextFileSync(${JSON.stringify(marker)}, "ran");\n${configBody}`,
  );
  const ran = () => Deno.stat(marker).then(() => true, () => false);
  return { dir, marker, ran };
}

/** `denext <args>` in `dir`, on a throwaway HOME. */
async function cli(
  dir: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; out: string }> {
  const home = await Deno.makeTempDir({ prefix: "denext-hostile-home-" });
  try {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", CLI, ...args],
      cwd: dir,
      // The module cache stays the machine's: a fresh one would download the CLI per case.
      env: { HOME: home, USERPROFILE: home, DENO_DIR: denoCacheDir(), NO_COLOR: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder();
    const out = text.decode(stdout);
    return { code, stdout: out, out: out + text.decode(stderr) };
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

/** Remove a fixture and its marker. */
async function cleanup(dir: string, marker: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.remove(marker).catch(() => {});
}

for (const args of [["routes"], ["routes", "--json"], ["info"], ["info", "--json"]]) {
  Deno.test(`denext ${args.join(" ")}: reads the project and runs none of it`, async () => {
    const { dir, marker, ran } = await hostile();
    try {
      const { code, out } = await cli(dir, ...args);
      assertEquals(code, 0, out);
      assertEquals(await ran(), false, "the config ran");
    } finally {
      await cleanup(dir, marker);
    }
  });
}

Deno.test("denext generate page --dry-run: runs none of the project", async () => {
  const { dir, marker, ran } = await hostile();
  try {
    const { code, out } = await cli(dir, "generate", "page", "x", "--dry-run");
    assertEquals(code, 0, out);
    assertEquals(await ran(), false, "the config ran");
  } finally {
    await cleanup(dir, marker);
  }
});

Deno.test("denext desktop doctor and add: run none of a desktop project", async () => {
  const { dir, marker, ran } = await hostile();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), '{ "desktop": {} }\n');
    await cli(dir, "desktop", "doctor", "--json");
    await cli(dir, "desktop", "add", "--list");
    assertEquals(await ran(), false, "the config ran");
  } finally {
    await cleanup(dir, marker);
  }
});

Deno.test("denext commands (the control): the fixture's marker does fire when the config runs", async () => {
  const { dir, marker, ran } = await hostile();
  try {
    await cli(dir, "commands", "--json");
    assert(await ran(), "the control never ran the config, so the other cases prove nothing");
  } finally {
    await cleanup(dir, marker);
  }
});

Deno.test("the MCP tools' and the UI's project reads run none of the project", async () => {
  const { dir, marker, ran } = await hostile();
  try {
    assertEquals((await collectRoutes(dir)).pages.length, 1); // denext_list_routes, denext routes
    await routeMap(dir, "/"); // denext_route_map
    await ensureCodeIndex(dir); // denext_index_codebase and the tools that read its cache
    // The UI's Generate panel and Setup step, in the UI's own process, and denext_generate.
    await generateArtifact(dir, "page", "x", { dryRun: true });
    assertEquals(await ran(), false, "the config ran");
  } finally {
    await cleanup(dir, marker);
  }
});

Deno.test("resolveProjectLayout is resolveProject's layout, and only resolveProject imports", async () => {
  const { dir, marker, ran } = await hostile();
  try {
    await Deno.mkdir(join(dir, "src", "app"), { recursive: true });
    await Deno.writeTextFile(join(dir, "src", "middleware.ts"), "export default () => {};\n");
    const layout = await resolveProjectLayout(dir);
    assertEquals(await ran(), false);
    assertEquals(layout.appDir, join(dir, "src", "app"));
    const { config: _config, i18n: _i18n, ...full } = await resolveProject(dir);
    assert(await ran());
    assertEquals(layout, full);
  } finally {
    await cleanup(dir, marker);
  }
});

Deno.test("readStaticConfig: data has a value, code doesn't, and no config is a null file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-static-config-" });
  try {
    assertEquals(await readStaticConfig(dir), {
      file: null,
      readable: true,
      keys: {},
      hidesKeys: false,
    });
    const path = join(dir, "denext.config.ts");
    await Deno.writeTextFile(path, 'export default { mode: "spa", desktop: makeIt() };\n');
    const config = await readStaticConfig(dir);
    assertEquals(config.file, "denext.config.ts");
    assertEquals(config.keys.mode.value, "spa");
    assertEquals(config.keys.desktop.kind, "readonly");
    await Deno.writeTextFile(path, "export default {{;\n");
    assertEquals((await readStaticConfig(dir)).readable, false);
    await Deno.writeTextFile(path, 'export const mode = "spa";\n');
    assertEquals((await readStaticConfig(dir)).keys.mode.value, "spa");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext info: mode comes from the config's text, unknown when code computes it", async () => {
  const { dir, marker, ran } = await hostile('export default { mode: "spa" };\n');
  try {
    const facts = (out: string) => JSON.parse(out);
    const spa = await cli(dir, "info", "--json");
    assertEquals(facts(spa.stdout).mode, "spa", spa.out);
    assertEquals(facts(spa.stdout).config, join(dir, "deno.json"));
    await Deno.writeTextFile(
      join(dir, "denext.config.ts"),
      "export default { mode: pick() };\nfunction pick() { return 'spa'; }\n",
    );
    assertEquals(facts((await cli(dir, "info", "--json")).stdout).mode, "unknown");
    assertEquals(await ran(), false);
  } finally {
    await cleanup(dir, marker);
  }
});

Deno.test("projectLaunchPolicy: a computed desktop key is a gap, and it isn't run", async () => {
  const { dir, marker, ran } = await hostile("export default { desktop: load() };\n");
  try {
    await Deno.writeTextFile(join(dir, "desktop.ts"), "");
    const [gap] = (await projectLaunchPolicy(dir))!;
    assertStringIncludes(gap.message, "could not be loaded");
    assertEquals(await ran(), false);
  } finally {
    await cleanup(dir, marker);
  }
});

// An unknown verb imports the config only when its text says it could add verbs.
for (
  const args of [
    ["biuld"],
    ["foo", "--help"],
    ["foo", "-h"],
    ["openapi", "lint"],
    ["content", "list"],
    ["functions", "list"],
    ["storage", "ls"],
    ["openapi", "lint", "--help"],
  ]
) {
  Deno.test(`denext ${args.join(" ")}: a config with no verbs doesn't run`, async () => {
    const { dir, marker, ran } = await hostile();
    try {
      const { code, out } = await cli(dir, ...args);
      assertEquals(code, 1, out);
      assertStringIncludes(out, `unknown command "${args[0]}"`);
      assertEquals(await ran(), false, "the config ran");
    } finally {
      await cleanup(dir, marker);
    }
  });
}

Deno.test("denext --cwd <dir> biuld: the static read is of that directory", async () => {
  const { dir, marker, ran } = await hostile();
  const other = await hostile(
    'export default { commands: [{ name: "seed", summary: "s", run() {} }] };\n',
  );
  try {
    const plain = await cli(other.dir, "--cwd", dir, "biuld");
    assertStringIncludes(plain.out, "Did you mean `denext build`?");
    assertEquals(await ran(), false, "the plain project's config ran");
    assertEquals(await other.ran(), false, "the caller's directory's config ran");
    const declared = await cli(dir, "--cwd", other.dir, "seed");
    assertEquals(declared.code, 0, declared.out);
    assertEquals(await ran(), false, "the caller's directory's config ran");
  } finally {
    await cleanup(dir, marker);
    await cleanup(other.dir, other.marker);
  }
});

Deno.test("an unknown verb's --help points at `denext commands`, and works once it has run", async () => {
  const { dir, marker, ran } = await hostile(
    'export default { commands: [{ name: "seed", summary: "Load it", run() {} }] };\n',
  );
  try {
    const typo = await cli(dir, "biuld", "--help");
    assertEquals(typo.code, 1, typo.out);
    assertStringIncludes(typo.out, "Did you mean `denext build`?");
    assertStringIncludes(typo.out, "`denext commands`");
    const before = await cli(dir, "seed", "--help");
    assertEquals(before.code, 1, before.out);
    assertStringIncludes(before.out, "`denext commands`");
    assertEquals(await ran(), false, "--help ran a config that declares commands");

    const home = await Deno.makeTempDir({ prefix: "denext-hostile-home-" });
    try {
      // One HOME's listing key isn't another's, so the listing and its reader share the machine's.
      const env = { DENO_DIR: denoCacheDir(), HOME: home, USERPROFILE: home, NO_COLOR: "1" };
      const run = (...args: string[]) =>
        new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", CLI, ...args],
          cwd: dir,
          env,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output();
      assertEquals((await run("commands", "--json")).code, 0);
      assert(await ran(), "`denext commands` is the explicit discovery");
      const after = await run("seed", "--help");
      assertEquals(after.code, 0, new TextDecoder().decode(after.stderr));
      assertStringIncludes(new TextDecoder().decode(after.stdout), "Load it");
    } finally {
      await Deno.remove(home, { recursive: true }).catch(() => {});
    }
  } finally {
    await cleanup(dir, marker);
  }
});

Deno.test("a config that declares commands still runs on an unknown verb: this is no sandbox", async () => {
  const { dir, marker, ran } = await hostile(
    'export default { commands: [{ name: "seed", summary: "s", run() {} }] };\n',
  );
  try {
    const typo = await cli(dir, "biuld");
    assertEquals(typo.code, 1, typo.out);
    assert(await ran(), "the documented limit changed: update /docs/security");
  } finally {
    await cleanup(dir, marker);
  }
});
