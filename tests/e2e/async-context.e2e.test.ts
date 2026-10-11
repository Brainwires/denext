// Real-browser E2E for `asyncContext: true` (tests/e2e/fixtures/async-context): the point of the
// option is that an async `startTransition` keeps its transition scope across `await`, so an
// unrelated urgent update made while it is pending stays urgent instead of being folded into the
// transition (the time-window fallback). The scoped transition here lives in a LAZILY imported
// module (`dynamic(() => import("./lazy.tsx"))` from an instrumented module) — the shape whose
// instrumented copy used to fail the build (`Module not found .denext/asyncctx/lazy.tsx`). The
// page also proves the copy's other imports resolve in the browser: a stylesheet, JSON, a
// template-literal `import()` and a platform-file variant.
//
// Built and served through the real CLI: the island imports a stylesheet, which the server can
// only import under the CLI's re-exec. Opt-in: run with `deno task test:e2e`.

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  assertNoConsoleErrors,
  collectConsoleErrors,
  launchBrowser,
  pollFor,
  runDeno,
  startCliServer,
} from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/async-context", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

/** textContent of `#id` in the page. */
const textOf = (id: string) => `(document.getElementById(${JSON.stringify(id)})||{}).textContent`;

Deno.test({
  name: "asyncContext e2e: a lazily imported module's async transition keeps its scope",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const built = await runDeno(["run", "-A", CLI, "build", "."], FIXTURE, 600_000);
    if (!built.ok) throw new Error(`denext build failed:\n${built.out}`);
    const server = await startCliServer(FIXTURE, 120_000);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const errors = collectConsoleErrors(page);
      await page.goto(server.origin + "/", { waitUntil: "load" });

      // The instrumented copy's imports, resolved in the browser.
      await pollFor(page, "globalThis.__acReady === true"); // the lazy chunk loaded and mounted
      await pollFor(page, `${textOf("extra")} === "extra-ok"`); // template-literal import()
      assertEquals(await page.evaluate(textOf("json")), "json-ok");
      assertEquals(await page.evaluate(textOf("platform")), "web");
      assertEquals(
        await page.evaluate(
          `getComputedStyle(document.querySelector(".ac-marker")).color`,
        ),
        "rgb(1, 2, 3)",
      );

      // Start the async transition; its post-await update waits on a gate.
      await page.evaluate("globalThis.__acStart()");
      await pollFor(page, `document.getElementById("ac-count").dataset.pending === "true"`);
      // An unrelated urgent update WHILE it is pending: scoped by identity, it is not inside the
      // transition, so it commits on the next microtask (the time window would demote it to the
      // transition lane, and it would still read 0 there).
      assertEquals(await page.evaluate("globalThis.__acUrgent()"), "1");
      // The gated update then lands as the transition, on top.
      await page.evaluate("globalThis.__acRelease()");
      await pollFor(page, `${textOf("ac-count")} === "11"`);
      await pollFor(page, `document.getElementById("ac-count").dataset.pending === "false"`);
      assertNoConsoleErrors(errors);
    } finally {
      await browser.close();
      await server.close();
    }
  },
});
