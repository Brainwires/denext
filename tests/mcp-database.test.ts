// `denext mcp`'s database tools: the CLI argv each one builds, an error surfacing as an error
// result, and one real child run of `denext migration list --json` on a SQLite project.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { databaseTools } from "../src/mcp/database.ts";
import { TOOL_GROUPS, TOOLS } from "../src/mcp/tools.ts";

Deno.test("database tools: argv, errors, the group", async () => {
  const calls: { args: string[]; dir: string }[] = [];
  let code = 0;
  const [migrations, types] = databaseTools((d) => String(d ?? "/p"), (args, dir) => {
    calls.push({ args, dir });
    return Promise.resolve({ code, stdout: "{}\n", stderr: "boom" });
  });
  assertEquals(await migrations.run({}), { text: "{}" });
  assertEquals(calls[0], { args: ["migration", "list", "--json"], dir: "/p" });
  await migrations.run({ action: "down", steps: 2, dryRun: true, dbUrl: "sqlite:x.db", dir: "/q" });
  assertEquals(calls[1], {
    args: ["migration", "down", "--json", "--db-url", "sqlite:x.db", "--steps", "2", "--dry-run"],
    dir: "/q",
  });
  await migrations.run({ action: "up", to: "20260101000000" });
  assertEquals(calls[2].args, ["migration", "up", "--json", "--to", "20260101000000"]);
  assertEquals((await migrations.run({ action: "drop" })).isError, true);
  await types.run({ schema: "public,app" });
  assertEquals(calls[3].args, ["gen", "types", "--schema", "public,app"]);
  code = 1;
  assertEquals(await types.run({}), { text: "boom", isError: true });
  assertEquals(TOOL_GROUPS.database, ["denext_migrations", "denext_gen_types"]);
  assert(TOOLS.some((t) => t.name === "denext_migrations"));
});

Deno.test("denext_migrations runs the CLI as a child", async () => {
  const root = await Deno.makeTempDir({ prefix: "dnx-mcp-db-" });
  try {
    await Deno.writeTextFile(`${root}/deno.json`, "{}");
    await Deno.mkdir(`${root}/migrations`);
    await Deno.writeTextFile(`${root}/migrations/1_a.sql`, "CREATE TABLE a (id INTEGER);");
    const tool = TOOLS.find((t) => t.name === "denext_migrations")!;
    const up = await tool.run({ action: "up", dir: root });
    assertEquals(up.isError, undefined, up.text);
    assertEquals(JSON.parse(up.text).applied, ["1_a.sql"]);
    const list = JSON.parse((await tool.run({ dir: root })).text);
    assertStringIncludes(list.database, "sqlite:app.db");
    assertEquals(list.migrations[0].remote, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
