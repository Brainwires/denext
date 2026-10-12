// denext 4.0 renamed background/scheduled "tasks" to "jobs" with no alias: a config that still
// sets `tasks` or `scheduledTasks` fails to load, naming the key that replaced it — whether the
// key sits on the default export or is a named export.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { validateRemovedConfigKeys } from "../src/server/config-validate.ts";

Deno.test("validateRemovedConfigKeys names the replacement of each renamed key", () => {
  const failure = (config: object): string => {
    try {
      validateRemovedConfigKeys(config, (field, msg) => {
        throw new Error(`${field}: ${msg}`);
      });
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };
  assertEquals(
    failure({ tasks: {} }),
    'tasks: was renamed in denext 4.0 — use `jobs` instead (background work is "jobs" now)',
  );
  assertEquals(
    failure({ scheduledTasks: {} }),
    "scheduledTasks: was renamed in denext 4.0 — use `scheduledJobs` instead " +
      '(background work is "jobs" now)',
  );
  assertEquals(failure({ jobs: {}, scheduledJobs: {} }), "");
});

async function load(config: string): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "denext_renamed_keys_" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(join(dir, "denext.config.ts"), config);
    await resolveProject(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a config setting `tasks` fails to load and points at `jobs`", async () => {
  await assertRejects(
    () => load("export default { tasks: { history: true } };\n"),
    Error,
    "`tasks` was renamed in denext 4.0 — use `jobs` instead",
  );
});

Deno.test("a named `scheduledTasks` export fails to load and points at `scheduledJobs`", async () => {
  await assertRejects(
    () => load('export const scheduledTasks = { "0 3 * * *": "cleanup" };\n'),
    Error,
    "`scheduledTasks` was renamed in denext 4.0 — use `scheduledJobs` instead",
  );
});

Deno.test("the new keys load", async () => {
  await load("export default { jobs: { history: false }, scheduledJobs: {} };\n");
});
