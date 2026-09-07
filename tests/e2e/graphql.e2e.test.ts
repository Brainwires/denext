// Networked e2e for examples/graphql: @denext/graphql end to end through the real CLI —
// `denext build` → `denext start` — then a query, a mutation, and a GraphQL-over-SSE
// subscription fed by a denext channel, against the served app.
//
// This drives the CLI as a subprocess ON PURPOSE: the example's server-side npm deps
// (graphql-yoga, graphql, @pothos/core) only resolve once the CLI re-execs with the merged
// framework+app config (see `maybeReexecForModules` in cli.ts). The in-process build harness
// runs under the framework's own config, where those bare imports can't resolve.
//
// Opt-in + NETWORK-REQUIRED (npm fetch on a cold cache): `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { runDeno, startCliServer } from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/graphql", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

const BUILD_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;

const gql = (origin: string, query: string, accept = "application/json") =>
  fetch(origin + "/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify({ query }),
  });

/** Read SSE frames until `count` `next` events arrived. */
async function nextEvents(res: Response, count: number): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out: unknown[] = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.match(/^data: (.*)$/m);
      if (frame.includes("event: next") && data) out.push(JSON.parse(data[1]));
    }
  }
  await reader.cancel();
  return out;
}

Deno.test({
  name: "e2e: examples/graphql serves a Pothos schema with a channel-backed subscription",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await t.step("build", async () => {
    const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
    if (!built.ok && /npm|registry|fetch|network/i.test(built.out)) {
      console.warn("e2e: build could not fetch npm deps (offline?) — skipping.\n" + built.out);
      return;
    }
    assert(built.ok, "denext build failed:\n" + built.out);
    const sdl = await Deno.readTextFile(EXAMPLE + "/.denext/schema.graphql");
    assertStringIncludes(sdl, "type Subscription {");
  });

  const server = await startCliServer(EXAMPLE, READY_TIMEOUT_MS);
  try {
    await t.step("page + query", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "GraphQL on denext");
      const res = await gql(server.origin, '{ history(room: "lobby") { text } }');
      assertEquals(await res.json(), { data: { history: [] } });
    });

    await t.step("subscription rides the channel: a mutation arrives over SSE", async () => {
      const sub = await gql(
        server.origin,
        'subscription { messages(room: "lobby") { text room } }',
        "text/event-stream",
      );
      assertEquals(sub.status, 200);
      // Let the subscription attach, then post.
      await new Promise((r) => setTimeout(r, 300));
      const posted = await gql(
        server.origin,
        'mutation { post(room: "lobby", text: "hello e2e") { text } }',
      );
      assertEquals(await posted.json(), { data: { post: { text: "hello e2e" } } });
      assertEquals(await nextEvents(sub, 1), [
        { data: { messages: { text: "hello e2e", room: "lobby" } } },
      ]);
      const after = await gql(server.origin, '{ history(room: "lobby") { text } }');
      assertEquals(await after.json(), { data: { history: [{ text: "hello e2e" }] } });
    });

    await t.step("GraphiQL is off in production", async () => {
      const ui = await fetch(server.origin + "/graphql", { headers: { accept: "text/html" } });
      assert(!(await ui.text()).includes("GraphiQL"));
    });
  } finally {
    await server.close();
  }
});
