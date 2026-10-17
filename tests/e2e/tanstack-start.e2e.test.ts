// Networked e2e for examples/tanstack-start: a TanStack Start app run by the
// `@denext/tanstack-start` plugin, end to end through the real CLI — `deno install` →
// `denext build` → `denext start` — then a real (headless) Chromium. Start's own handler answers
// every request: pages stream through the matched routes (a nested layout, a deferred loader
// promise streaming in after the shell, a route's error component), server routes answer with
// their handlers, and server functions (`createServerFn`) are called over Start's RPC — from a
// loader on the server, and from the browser after hydration, with middleware and validation.
// denext refuses a cross-origin server function POST before Start sees it.
//
// Opt-in + NETWORK-REQUIRED (`deno install` fetches the TanStack packages from npm):
// `deno task test:e2e`. Skipped automatically if the install can't reach npm.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  assertNoConsoleErrors,
  collectConsoleErrors,
  launchBrowser,
  runDeno,
  startCliServer,
} from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/tanstack-start", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Safari/537.36";

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["newPage"]>>;

/** The text of the first element matching `selector`, polled until `ok(text)` (≤ ~15 s). */
async function textWhen(page: Page, selector: string, ok: (text: string) => boolean) {
  let text = "";
  for (let i = 0; i < 150; i++) {
    text = await page.evaluate(
      (s: string) => document.querySelector(s)?.textContent ?? "",
      { args: [selector] },
    );
    if (ok(text)) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  return text;
}

/** Wait for Start's client to hydrate (it sets its options global when it does). */
async function hydrated(page: Page): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(() => "__TSS_START_OPTIONS__" in globalThis)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the page never hydrated");
}

Deno.test({
  name: "e2e: examples/tanstack-start runs a TanStack Start app on denext",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const install = await runDeno(["install"], EXAMPLE, 180_000);
  if (!install.ok) {
    console.warn("e2e: `deno install` failed (npm unreachable?) — skipping.\n" + install.out);
    return;
  }
  const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, 240_000);
  assert(built.ok, "denext build failed:\n" + built.out);

  const server = await startCliServer(EXAMPLE, 60_000);
  try {
    await t.step("a page streams through its nested routes, with the client entry", async () => {
      const html = await (await fetch(server.origin + "/posts/3")).text();
      assert(html.startsWith("<!DOCTYPE html><html"), "the shellComponent is the document");
      assert(html.endsWith("</body></html>"), "the document closes after every streamed part");
      assertStringIncludes(html, "<title>The plugin owns the route tree</title>", "route head");
      assertStringIncludes(html, '<div id="posts-layout">', "the /posts layout route rendered");
      assertStringIncludes(html, "<h1>The plugin owns the route tree</h1>", "the loader ran");
      assert(
        html.indexOf('id="posts-layout"') < html.indexOf('<article id="post">'),
        "the post renders inside the layout's <Outlet />",
      );
      assertStringIncludes(html, '<script type="module" src="/_tss/client.js"');
      assertEquals((await fetch(server.origin + "/_tss/client.js")).status, 200);
    });

    await t.step("the client bundle carries no server-only code", async () => {
      let js = "";
      for await (const f of Deno.readDir(join(EXAMPLE, ".denext", "tanstack-start", "client"))) {
        if (f.name.endsWith(".js")) {
          js += await Deno.readTextFile(
            join(EXAMPLE, ".denext", "tanstack-start", "client", f.name),
          );
        }
      }
      assertStringIncludes(js, "/_serverFn/", "server functions are RPC stubs");
      for (const leak of ["notes.push", "A note needs some text", 'searchParams.get("name")']) {
        assert(!js.includes(leak), `the client bundle leaks ${leak}`);
      }
      assert(!js.includes("AsyncLocalStorage"), "Start's server-only context stayed on the server");
    });

    await t.step("a deferred loader promise streams in after the shell", async () => {
      // A browser's User-Agent: Start answers a crawler (Deno's own UA counts as one) only once
      // every boundary has rendered.
      const res = await fetch(server.origin + "/deferred", {
        headers: { "user-agent": BROWSER_UA },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      assertStringIncludes(first, "<!DOCTYPE html>");
      assert(!first.includes("streamed in later"), "the first chunk does not wait for the promise");
      let html = first;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
      }
      assertStringIncludes(html, '<p id="later-pending">waiting…</p>', "the fallback streamed");
      assertStringIncludes(html, '<p id="later">streamed in later</p>', "the value streamed");
      assert(html.indexOf("later-pending") < html.indexOf('id="later"'));
      assert(html.indexOf('id="later"') < html.indexOf("</body>"), "inside the document");
    });

    await t.step("a failing loader renders the route's errorComponent", async () => {
      const res = await fetch(server.origin + "/boom");
      assertEquals(res.status, 500);
      const html = await res.text();
      assertStringIncludes(html, '<p id="route-error">Caught: the loader failed on purpose</p>');
      assertStringIncludes(html, '<nav aria-label="Main">', "inside the root layout");
    });

    await t.step("a server route answers with its handlers", async () => {
      const get = await fetch(server.origin + "/api/hello?name=denext");
      assertEquals(await get.json(), { hello: "denext" });
      const post = await fetch(server.origin + "/api/hello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 1 }),
      });
      assertEquals(await post.json(), { echo: { n: 1 } });
    });

    await t.step("a cross-origin server function POST is refused", async () => {
      const call = (origin: string) =>
        fetch(server.origin + "/_serverFn/no-such-function", {
          method: "POST",
          headers: { "x-tsr-serverFn": "true", "content-type": "application/json", origin },
          body: "{}",
        });
      const evil = await call("https://evil.example");
      assertEquals(evil.status, 403);
      assertStringIncludes(await evil.text(), "cross-origin server function call");
      const own = await call(server.origin);
      assertNotEquals(own.status, 403, "the app's own origin reaches Start");
      await own.body?.cancel();
    });

    const browser = await launchBrowser();
    try {
      await t.step("the browser hydrates, then navigates on the client", async () => {
        const page = await browser.newPage(server.origin + "/");
        const errors = collectConsoleErrors(page);
        await page.waitForSelector("#home", { timeout: 20_000 });
        await page.evaluate(() => {
          (globalThis as unknown as { __sameDocument: boolean }).__sameDocument = true;
        });
        // Hydrated: the server's button now answers clicks.
        for (let i = 0; i < 100; i++) {
          await page.evaluate(() => (document.querySelector("#count") as HTMLElement).click());
          const text = await page.evaluate(() => document.querySelector("#count")!.textContent);
          if (text !== "clicked 0") break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert(
          await page.evaluate(() => document.querySelector("#count")!.textContent !== "clicked 0"),
          "the hydrated button updates its state",
        );
        assertEquals(
          await page.evaluate(() => document.querySelector("#rendered-on")!.textContent),
          "loader ran on the server",
          "hydration reused the server's loader data",
        );
        await (await page.$('nav a[href="/posts"]'))!.click();
        await page.waitForSelector("#posts", { timeout: 15_000 });
        const state = await page.evaluate(() => ({
          path: location.pathname,
          sameDocument:
            (globalThis as unknown as { __sameDocument?: boolean }).__sameDocument === true,
          items: document.querySelectorAll("#posts-layout #posts li").length,
        }));
        assertEquals(state, { path: "/posts", sameDocument: true, items: 3 });
        await (await page.$('#posts a[href="/posts/2"]'))!.click();
        await page.waitForSelector("#posts-layout #post", { timeout: 15_000 });
        assertStringIncludes(
          await page.evaluate(() => document.querySelector("#post")!.textContent ?? ""),
          "Then the router takes over",
        );
        // A deferred loader on a client navigation: its value arrives after the fallback.
        await (await page.$('nav a[href="/deferred"]'))!.click();
        assertEquals(await textWhen(page, "#later", (s) => s !== ""), "streamed in later");
        assertNoConsoleErrors(errors);
        await page.close();
      });

      await t.step("the browser calls server functions", async () => {
        const page = await browser.newPage(server.origin + "/notes");
        const errors = collectConsoleErrors(page);
        await page.waitForSelector("#notes", { timeout: 20_000 });
        await hydrated(page);
        await (await page.$("#note-text"))!.type("  written in the browser  ");
        await page.evaluate(() => (document.querySelector("#add-note") as HTMLElement).click());
        // POST: the middleware's server half set `ranOn`.
        assertStringIncludes(
          await textWhen(page, "#note-status", (s) => s !== ""),
          "on the server",
        );
        // router.invalidate() re-ran the loader: a GET server function over RPC; the validator
        // trimmed the text.
        assertEquals(
          await textWhen(page, "#notes li:last-child", (s) => s.includes("written")),
          "written in the browser",
        );
        // An invalid input is refused by the validator, on the server.
        await page.evaluate(() => (document.querySelector("#add-note") as HTMLElement).click());
        assertEquals(
          await textWhen(page, "#note-status", (s) => s.startsWith("error")),
          "error: A note needs some text",
        );
        assertNoConsoleErrors(errors);
        await page.close();
      });

      await t.step("an error route hydrates with its errorComponent", async () => {
        const page = await browser.newPage(server.origin + "/boom");
        await page.waitForSelector("#route-error", { timeout: 20_000 });
        await hydrated(page);
        assertEquals(
          await page.evaluate(() => document.querySelector("#route-error")!.textContent),
          "Caught: the loader failed on purpose",
        );
        await page.close();
      });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
});
