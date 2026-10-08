// Networked e2e for examples/react-router: a React Router v7 framework-mode app on denext via
// @denext/react-router, end to end through the real CLI — `denext build` → `denext start` —
// asserting loader data (as prop AND via useLoaderData), a pathless layout, a dynamic route, a
// Form action, a resource route, a thrown Response → ErrorBoundary (418), a 404, and — in a
// real browser — a hydrating clientLoader (HydrateFallback first) and a clientAction.
//
// Drives the CLI as a subprocess to mirror the other example e2es (the plugin generates route
// wrappers into .denext/react-router at build time). Zero npm, so no offline-degrade branch.
//
// Opt-in: `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { collectConsoleLogs, launchBrowser, pollFor, runDeno, startCliServer } from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/react-router", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

const BUILD_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;

Deno.test({
  name: "e2e: examples/react-router serves an RR7 framework-mode app through the App Router",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await t.step("build generates the route wrappers", async () => {
    const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
    assert(built.ok, "denext build failed:\n" + built.out);
    const root = await Deno.readTextFile(
      EXAMPLE + "/.denext/react-router/root/layout.tsx",
    );
    assertStringIncludes(root, "Layout", "the root Layout export becomes the generated layout");
  });

  const server = await startCliServer(EXAMPLE, READY_TIMEOUT_MS);
  try {
    await t.step("home: loader data as a prop and via useLoaderData", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, 'data-app="rr7"', "the root Layout renders the document");
      assertStringIncludes(html, '<h1 id="home">hello from a loader</h1>');
      assertStringIncludes(html, "Same value via the hook: hello from a loader");
    });

    await t.step("pathless layout wraps a dynamic route", async () => {
      const teams = await (await fetch(server.origin + "/teams")).text();
      assertStringIncludes(teams, 'id="shell"');
      assertStringIncludes(teams, 'id="teams"');
      const team = await (await fetch(server.origin + "/teams/42")).text();
      assertStringIncludes(team, "Team 42 (param: 42)");
    });

    await t.step("the route action answers a POST", async () => {
      const form = new FormData();
      form.set("name", "Deno");
      const res = await fetch(server.origin + "/teams/42", { method: "POST", body: form });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { renamed: "Deno" });
    });

    await t.step("a resource route answers GET", async () => {
      assertEquals(await (await fetch(server.origin + "/api/health")).json(), { ok: true });
    });

    await t.step("a thrown Response reaches the ErrorBoundary with its status", async () => {
      const res = await fetch(server.origin + "/boom");
      assertEquals(res.status, 418);
      assertStringIncludes(await res.text(), "caught 418");
    });

    await t.step("unknown path 404s", async () => {
      assertEquals((await fetch(server.origin + "/nope")).status, 404);
    });

    await t.step("prerender: a listed static route is force-static", async () => {
      const about = await Deno.readTextFile(
        EXAMPLE + "/.denext/react-router/routes__about/page.tsx",
      );
      assertStringIncludes(about, 'export const dynamic = "force-static";');
      assertStringIncludes(await (await fetch(server.origin + "/about")).text(), 'id="about"');
    });

    await t.step("clientLoader.hydrate: the server renders the HydrateFallback", async () => {
      const html = await (await fetch(server.origin + "/client")).text();
      assertStringIncludes(html, 'id="client-fallback"');
      assert(!html.includes('id="client"'), "the component waits for the clientLoader");
    });

    await t.step("in the browser: clientLoader data, then a clientAction", async () => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage();
        const logs = collectConsoleLogs(page);
        await page.goto(server.origin + "/client");
        const failWith = async (err: unknown) => {
          const dom = await page.evaluate(`document.body.innerHTML`);
          throw new Error(`${err}\nconsole: ${logs.join(" | ")}\nbody: ${dom}`);
        };
        await pollFor(
          page,
          `document.getElementById("client")?.textContent === "server loader + clientLoader"`,
        );
        await page.evaluate(`document.getElementById("save").click()`);
        await pollFor(
          page,
          `document.getElementById("saved")?.textContent === "hello (via clientAction)"`,
          20_000,
        ).catch(failWith);
      } finally {
        await browser.close();
      }
    });
  } finally {
    await server.close();
  }
});
