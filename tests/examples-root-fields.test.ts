// The desktop examples that are their own Deno workspace root (`"workspace": []`) carry the root
// fields a scaffold writes (src/build/scaffold.ts's DENO_ROOT_FIELDS): without `allowScripts`'
// deny of `@parcel/watcher` (through `sass` in the framework's graph), Deno prints its "Ignored
// build scripts" warning box ahead of `denext desktop package --regenerate-scripts` and every other
// command run in an app copied from the example.

import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DENO_ROOT_FIELDS } from "../src/build/scaffold.ts";

const EXAMPLES = fromFileUrl(new URL("../examples/", import.meta.url));

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

Deno.test("self-rooted desktop examples deny the framework graph's lifecycle script", async () => {
  const checked: string[] = [];
  const missing: string[] = [];
  for await (const e of Deno.readDir(EXAMPLES)) {
    const dir = join(EXAMPLES, e.name);
    if (!e.isDirectory || !await exists(join(dir, "desktop.ts"))) continue;
    const config = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
    if (!Array.isArray(config.workspace)) continue; // a member: the root's fields apply
    checked.push(e.name);
    if (JSON.stringify(config.allowScripts) !== JSON.stringify(DENO_ROOT_FIELDS.allowScripts)) {
      missing.push(e.name);
    }
  }
  assertEquals(checked.includes("hangar"), true, checked.join(", "));
  assertEquals(missing.sort(), []);
});
