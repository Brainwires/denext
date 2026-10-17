// A next-compat app whose page posts Server Actions from `<form>`s and imports NO "use client"
// module (tests/helpers/next-compat-action-form-fixture.ts), built and served in process: the
// `"use server"` module is an entry of the compat server bundle (so the instance the server tags
// is the one the page renders), both forms render their action endpoint, a JavaScript-free POST
// runs each action, and the document has one <html>/<body>, the root layout's attributes on them.
// Before, the build bundled action modules only when some route reached a client island: the
// page's form rendered with no `action`, and the server failed at startup loading the module's
// `next/cache` import from source. The browser half is tests/e2e/next-compat-action-form.e2e.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { build } from "../src/build/build.ts";
import { stopNextCompat } from "../src/build/next-compat.ts";
import { serveEphemeral } from "../src/build/prod-server.ts";
import { writeActionFormFixture } from "./helpers/next-compat-action-form-fixture.ts";

Deno.test({
  name: "next-compat: Server Action forms on a page with no client module work without JavaScript",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_ncform_" }));
  try {
    await writeActionFormFixture(dir, false);
    await build(dir);
    const manifest = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "manifest.json")));
    assert(
      "app/actions.ts" in manifest.compatServerModules,
      `the action module is a server bundle entry: ${JSON.stringify(manifest.compatServerModules)}`,
    );
    const server = await serveEphemeral(dir);
    try {
      const html = await (await fetch(server.origin + "/")).text();
      for (const tag of ["html", "body"]) {
        assertEquals(html.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length, 1, `one <${tag}>`);
      }
      assertStringIncludes(html, '<html lang="fr" class="dark">');
      assertStringIncludes(html, '<body class="shell"><div id="__denext"><main>');
      for (
        const [form, title, listed] of [
          ["exported", "from-the-module", "from-the-module"],
          ["inline", "from-inline", "inline:from-inline"],
        ]
      ) {
        const action = html.match(new RegExp(`<form id="${form}" action="([^"]+)" method="post">`))
          ?.[1];
        assert(action?.startsWith("/_denext/action/"), `the ${form} form posts to its action`);
        const post = await fetch(server.origin + action, {
          method: "POST",
          headers: {
            Origin: server.origin,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `title=${title}`,
          redirect: "manual",
        });
        assertEquals(post.status, 303, "a no-JS post redirects back to the page");
        await post.body?.cancel();
        assertStringIncludes(await (await fetch(server.origin + "/")).text(), `<li>${listed}</li>`);
      }
    } finally {
      await server.close();
    }
  } finally {
    await stopNextCompat();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
