// Dev re-tagging after an edit: `forgetTaggedServers` / `forgetTaggedClients` clear the
// "already tagged" sets so the next pass loads an edited module's new instance. A pass that was
// still loading when the set was cleared must not mark its (pre-edit) module tagged afterwards,
// or every later pass skips the module and the edit never registers. And one `"use server"`
// module that fails to load must not leave the others unregistered.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  actionIdFor,
  forgetTaggedServers,
  getServerAction,
  tagServerModules,
} from "../src/runtime/server-action.ts";
import {
  clientRefOf,
  forgetTaggedClients,
  tagClientModules,
} from "../src/runtime/client-reference.ts";

Deno.test("tagServerModules: a pass that straddles forgetTaggedServers doesn't mark its module tagged", async () => {
  const scope = `race-${crypto.randomUUID()}`;
  const moduleId = `race-server-${crypto.randomUUID()}`;
  const servers: [string, { url: string }][] = [[moduleId, { url: "mem:race-server" }]];
  const before = { act: () => "before the edit" };
  const after = { act: () => "after the edit" };
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  let loads = 0;
  const first = tagServerModules(servers, async () => {
    loads++;
    await gate; // still loading the pre-edit instance when the edit lands
    return before;
  }, scope);
  forgetTaggedServers(); // the watcher's bumpGeneration
  release();
  await first;
  await tagServerModules(servers, () => {
    loads++;
    return Promise.resolve(after);
  }, scope);
  assertEquals(loads, 2, "the next pass must load the edited module again");
  const handler = getServerAction(actionIdFor(moduleId, "act"), scope);
  assertEquals((handler as () => string)(), "after the edit");
});

Deno.test("tagClientModules: a pass that straddles forgetTaggedClients doesn't mark its module tagged", async () => {
  const scope = `race-${crypto.randomUUID()}`;
  const clientId = `race-client-${crypto.randomUUID()}`;
  const clients: [string, { url: string }][] = [[clientId, { url: "mem:race-client" }]];
  const after = { Island: () => null };
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  let loads = 0;
  const first = tagClientModules(clients, async () => {
    loads++;
    await gate;
    return { Island: () => null };
  }, scope);
  forgetTaggedClients();
  release();
  await first;
  await tagClientModules(clients, () => {
    loads++;
    return Promise.resolve(after);
  }, scope);
  assertEquals(loads, 2, "the next pass must tag the edited island's new instance");
  assert(clientRefOf(after.Island), "the edited island is a client reference");
});

Deno.test("tagServerModules: one module failing to load still registers the others, then throws", async () => {
  const scope = `broken-${crypto.randomUUID()}`;
  const good = `good-${crypto.randomUUID()}`;
  const broken = `broken-${crypto.randomUUID()}`;
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const failure = tagServerModules(
    [[broken, { url: "mem:broken" }], [good, { url: "mem:good" }]],
    async (url) => {
      if (url === "mem:broken") throw new SyntaxError("Unexpected token in broken module");
      await gate; // the healthy module loads after the broken one has already failed
      return { ok: () => "ok" };
    },
    scope,
  );
  setTimeout(release, 0); // a macrotask: after every microtask of the failed load
  await assertRejects(() => failure, SyntaxError, "broken module");
  assert(
    getServerAction(actionIdFor(good, "ok"), scope),
    "the healthy module's action is registered by the time the failure surfaces",
  );
});
