// Inline Server Actions on the native App Router (tests/helpers/native-action-form-fixture.ts): a
// Server Component's `async function addInline() { "use server"; … }` renders its `<form>` with the
// action endpoint, and a JavaScript-free POST runs it and redirects back to the page — under
// `denext start` (the build's server copies), `denext dev` (the dev copy compiler, also for a post
// from a page this server never rendered), and `denext export` (the endpoint in the HTML). The
// action ids are the ones next-compat mints for the same module. Before, the native server loaded
// the page as written: the function stayed a plain function and the form had no `action`.
// The browser half is tests/e2e/native-inline-action-form.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { serveEphemeral } from "../src/build/prod-server.ts";
import { startDevServer } from "../src/build/dev-server.ts";
import { resolveProject } from "../src/build/paths.ts";
import { resetModuleGraphCache } from "../src/build/module-graph.ts";
import { actionIdFor, forgetTaggedServers } from "../src/runtime/server-action.ts";
import { writeNativeActionFormFixture } from "./helpers/native-action-form-fixture.ts";
import { serverModuleIdFor } from "../src/build/boundary-ids.ts";
import { buildInChild, exportInChild } from "./helpers/bounded-build.ts";
import { watchTests } from "./helpers/watchdog.ts";

// Builds in this process: a stalled one fails its test instead of holding the CI job.
watchTests();

/** A fresh fixture project (real path: the ids hash the module URL the server loads). */
async function fixture(options: { static?: boolean; closure?: boolean } = {}): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_native_inline_" }));
  await writeNativeActionFormFixture(dir, options);
  return dir;
}

/** The action URL the form `#id` posts to in `html`, if any. */
function formAction(html: string, id: string): string | undefined {
  return html.match(new RegExp(`<form id="${id}" action="([^"]+)" method="post">`))?.[1];
}

/** POST `title` to `action` as a JavaScript-free form does; returns the response. */
function postForm(origin: string, action: string, title: string): Promise<Response> {
  return fetch(origin + action, {
    method: "POST",
    headers: {
      Origin: origin,
      Referer: origin + "/",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `title=${encodeURIComponent(title)}`,
    redirect: "manual",
  });
}

/** Post `title` through the page's inline form and check it is listed after the 303. */
async function assertInlinePost(origin: string, title: string): Promise<void> {
  const html = await (await fetch(origin + "/")).text();
  const action = formAction(html, "inline");
  assert(action?.startsWith("/_denext/action/"), `the inline form posts to its action: ${html}`);
  const post = await postForm(origin, action!, title);
  assertEquals(post.status, 303, "a no-JS post redirects back to the page");
  assertEquals(post.headers.get("location"), "/");
  await post.body?.cancel();
  assertStringIncludes(await (await fetch(origin + "/")).text(), `<li>inline:${title}</li>`);
}

/** The id next-compat's server bundle gives the page's first inline action (`addInline`). */
function compatId(dir: string): string {
  return actionIdFor(toFileUrl(join(dir, "app", "page.tsx")).href, "inline:0:addInline");
}

Deno.test({
  name: "native inline Server Action: `denext start` renders its endpoint and runs a no-JS post",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await fixture();
  try {
    await buildInChild(dir);
    const server = await serveEphemeral(dir);
    try {
      const html = await (await fetch(server.origin + "/")).text();
      assertEquals(formAction(html, "inline"), `/_denext/action/${compatId(dir)}`, "compat's id");
      await assertInlinePost(server.origin, "from-start");
      // The build's bound-action key stays on the server.
      const manifest = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "manifest.json")));
      assert(typeof manifest.serverActionsKey === "string", "the build recorded a key");
      assert(typeof manifest.actionIdSecret === "string", "the build recorded its id secret");
      for (
        const path of [
          "/manifest.json",
          "/_denext/manifest.json",
          "/_denext/client/../manifest.json",
          "/_denext/client/%2e%2e/manifest.json",
          "/.denext/manifest.json",
        ]
      ) {
        const res = await fetch(server.origin + path);
        const text = await res.text();
        assert(!text.includes(manifest.serverActionsKey), `${path} serves the key`);
        assert(!text.includes(manifest.actionIdSecret), `${path} serves the id secret`);
      }
    } finally {
      await server.close();
    }
    // No client output carries the action's body.
    for await (const entry of Deno.readDir(join(dir, ".denext", "client"))) {
      if (!entry.isFile || !entry.name.endsWith(".js")) continue;
      const js = await Deno.readTextFile(join(dir, ".denext", "client", entry.name));
      assert(!js.includes(`"inline:"`), `${entry.name} carries the inline action's body`);
    }
  } finally {
    // Every fixture's action module has the same id (`app/actions.ts`): let the next be tagged.
    forgetTaggedServers();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** Start the App Router dev server on `dir` (ephemeral port). */
async function devServer(dir: string, unbundled: boolean) {
  resetModuleGraphCache();
  const controller = new AbortController();
  const paths = await resolveProject(dir);
  let server: Deno.HttpServer | undefined;
  const port = await new Promise<number>((resolve) => {
    server = startDevServer({
      paths,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      unbundled,
      onListen: ({ port }) => resolve(port),
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: async () => {
      controller.abort();
      await server?.finished;
    },
  };
}

for (const unbundled of [false, true]) {
  Deno.test({
    name: `native inline Server Action: \`denext dev\`${
      unbundled ? " (unbundled)" : ""
    } renders its endpoint and runs a no-JS post`,
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    const dir = await fixture();
    try {
      // A post from a page this server never rendered (it restarted since): the action
      // registers when the dev server loads the modules holding one.
      const fresh = await devServer(dir, unbundled);
      try {
        const post = await postForm(fresh.origin, `/_denext/action/${compatId(dir)}`, "cold");
        assertEquals(post.status, 303, "an unrendered page's inline action still runs");
        await post.body?.cancel();
      } finally {
        await fresh.stop();
      }
      const dev = await devServer(dir, unbundled);
      try {
        await assertInlinePost(dev.origin, "from-dev");
      } finally {
        await dev.stop();
      }
    } finally {
      // Every fixture's action module has the same id (`app/actions.ts`): let the next be tagged.
      forgetTaggedServers();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}

Deno.test({
  name: "native inline Server Action: `denext export` renders its endpoint",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await fixture({ static: true });
  // The export runs in its own process: the shared secret a deploy that builds more than once
  // sets makes its ids the ones this process (a server of another build) mints.
  Deno.env.set("DENEXT_ACTION_ID_SECRET", "export-and-server-share-this");
  try {
    const { outDir } = await exportInChild(dir);
    const html = await Deno.readTextFile(join(outDir, "index.html"));
    assertEquals(formAction(html, "inline"), `/_denext/action/${compatId(dir)}`);
  } finally {
    Deno.env.delete("DENEXT_ACTION_ID_SECRET");
    // Every fixture's action module has the same id (`app/actions.ts`): let the next be tagged.
    forgetTaggedServers();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "native bound Server Actions: a closure and `.bind` post their sealed values, no-JS",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await fixture({ closure: true });
  try {
    await buildInChild(dir);
    const server = await serveEphemeral(dir);
    try {
      const html = await (await fetch(server.origin + "/")).text();
      // The page has no item yet: the closure reads `prefix` = "closed-0".
      const closure = formAction(html, "closure")!;
      const bound = formAction(html, "bound")!;
      assert(closure?.startsWith("/_denext/action/") && bound?.startsWith("/_denext/action/"));
      assert(!html.includes("closed-0"), "the closed-over value is not in the page");
      assert(!html.includes("tag-xyz"), "nor the bound one");
      for (
        const [action, title, listed] of [[closure, "c", "closed-0:c"], [bound, "b", "tag-xyz:b"]]
      ) {
        const post = await postForm(server.origin, action, title);
        assertEquals(post.status, 303, `${action} runs`);
        await post.body?.cancel();
        assertStringIncludes(await (await fetch(server.origin + "/")).text(), `<li>${listed}</li>`);
      }
      // An edited token is an unknown action: nothing is added.
      const [base, token] = closure.split(".");
      const edited = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
      const tampered = await postForm(server.origin, `${base}.${edited}`, "evil");
      assertEquals(tampered.status, 404);
      await tampered.body?.cancel();
      assert(!(await (await fetch(server.origin + "/")).text()).includes("evil"));
      // An export no module imports is refused like an unknown id, under its real id.
      const actionsUrl = toFileUrl(join(dir, "app", "actions.ts")).href;
      const unreferenced = actionIdFor(
        serverModuleIdFor(join(dir, "app"), actionsUrl),
        "addUnreferenced",
      );
      const refused = await postForm(server.origin, `/_denext/action/${unreferenced}`, "sneak");
      assertEquals(refused.status, 404);
      await refused.body?.cancel();
      assert(!(await (await fetch(server.origin + "/")).text()).includes("unreferenced:"));
    } finally {
      await server.close();
    }
  } finally {
    // Every fixture's action module has the same id (`app/actions.ts`): let the next be tagged.
    forgetTaggedServers();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
