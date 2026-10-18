// Networked e2e for examples/tanstack-start: a TanStack Start app run by the
// `@denext/tanstack-start` plugin, end to end through the real CLI — `deno install` →
// `denext build` (the client and the server bundle) → `denext start` (which loads the server
// bundle the build made) — then a real (headless) Chromium. Start's own handler answers
// every request: pages stream through the matched routes (a nested layout, a deferred loader
// promise streaming in after the shell, a route's error component), server routes answer with
// their handlers, and server functions (`createServerFn`) are called over Start's RPC — from a
// loader on the server, and from the browser after hydration, with middleware and validation.
// denext refuses a cross-origin server function POST before Start sees it. Then `denext export`:
// Start's prerender writes the static pages (and the crawled dynamic ones), lists the routes that
// need a server, writes Start's SPA shell and sitemap, and the static site hydrates and navigates
// on the client in Chromium (a path with no file served Start's SPA shell, which the app renders)
// — and, with JavaScript off, renders from its HTML and follows a link with a full page load.
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
  // `denext build` built the server bundle too, and recorded it for `denext start`.
  const out = join(EXAMPLE, ".denext", "tanstack-start");
  const record = JSON.parse(await Deno.readTextFile(join(out, "server.json")));
  const serverBundle = join(out, record.bundle);
  const builtAt = (await Deno.stat(serverBundle)).mtime?.getTime();

  const server = await startCliServer(EXAMPLE, 60_000);
  try {
    await t.step("`denext start` serves the server bundle the build made", async () => {
      assertEquals((await fetch(server.origin + "/")).status, 200);
      assertEquals(
        (await Deno.stat(serverBundle)).mtime?.getTime(),
        builtAt,
        "the first request did not build the server bundle again",
      );
    });

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
      // src/functions/notes.server.ts (only the server functions' handlers use it), the
      // handlers' bodies and a server route's handler: none of it ships.
      for (
        const leak of [
          "notes.push",
          "notes.server.ts stored note",
          "Server functions run on the server",
          "saveNote(",
          "readNotes(",
          'searchParams.get("name")',
        ]
      ) {
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

/**
 * Serve a static export as a static host would: `<path>/index.html`, then the file itself, then
 * (a page path with no file) the `fallback` file when one is given.
 * `served` lists each file answered, relative to the export (`posts/2/index.html`).
 */
function serveStatic(
  root: string,
  fallback?: string,
): { origin: string; served: string[]; close(): Promise<void> } {
  const served: string[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const candidates = [join(root, path, "index.html"), join(root, path)];
    if (fallback && !/\.\w+$/.test(path)) candidates.push(join(root, fallback));
    for (const candidate of candidates) {
      const body = await Deno.readFile(candidate).catch(() => null);
      if (!body) continue;
      served.push(candidate.slice(root.length + 1).replace(/\\/g, "/"));
      const type = candidate.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8";
      return new Response(body, { headers: { "content-type": type } });
    }
    return new Response("Not Found", { status: 404 });
  });
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    served,
    close: () => server.shutdown(),
  };
}

Deno.test({
  name: "e2e: examples/tanstack-start exports a static site with Start's prerender",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const install = await runDeno(["install"], EXAMPLE, 180_000);
  if (!install.ok) {
    console.warn("e2e: `deno install` failed (npm unreachable?) — skipping.\n" + install.out);
    return;
  }
  const exported = await runDeno(["run", "-A", CLI, "export", "."], EXAMPLE, 240_000);
  assert(exported.ok, "denext export failed:\n" + exported.out);
  const out = join(EXAMPLE, "out");

  await t.step("the static pages, the crawled ones and the client bundle are written", async () => {
    for (
      const page of [
        // Start's SPA shell takes `/` (spa.maskPath), as in Start: no index.html.
        "_shell.html",
        "sitemap.xml",
        "pages.json",
        "about/index.html",
        "deferred/index.html",
        "posts/index.html",
        "posts/1/index.html",
        "posts/3/index.html",
        "_tss/client.js",
      ]
    ) {
      await Deno.stat(join(out, page));
    }
    const post = await Deno.readTextFile(join(out, "posts", "3", "index.html"));
    assert(post.startsWith("<!DOCTYPE html><html"), "a whole document");
    assertStringIncludes(post, "<title>The plugin owns the route tree</title>");
    assertStringIncludes(post, "/_tss/client.js");
    // The deferred loader's value is in the page: the prerender waited for the whole stream.
    assertStringIncludes(
      await Deno.readTextFile(join(out, "deferred", "index.html")),
      "streamed in later",
    );
  });

  await t.step("Start's SPA shell and sitemap are written", async () => {
    const shell = await Deno.readTextFile(join(out, "_shell.html"));
    assert(shell.startsWith("<!DOCTYPE html><html"), "a whole document");
    assertStringIncludes(shell, "/_tss/client.js");
    assert(!shell.includes('id="home"'), "the shell renders no route: the root route alone");
    assertEquals(
      await Deno.stat(join(out, "index.html")).then(() => true, () => false),
      false,
      "the shell takes its mask path",
    );
    const sitemap = await Deno.readTextFile(join(out, "sitemap.xml"));
    assertStringIncludes(
      sitemap,
      "<!--This file was automatically generated by TanStack Start.-->",
    );
    assertStringIncludes(sitemap, "<loc>https://example.com/about</loc>");
    assertStringIncludes(sitemap, "<loc>https://example.com/posts/3</loc>");
    assert(!sitemap.includes("<loc>https://example.com/</loc>"), "the shell is not listed");
    const pages = JSON.parse(await Deno.readTextFile(join(out, "pages.json")));
    assertEquals(pages.host, "https://example.com");
    assertStringIncludes(exported.out, "[sitemap] Building Sitemap...");
  });

  await t.step("the routes that need a server are listed and left out", async () => {
    assertStringIncludes(exported.out, "2 route(s) need a server and are not in the export");
    assertStringIncludes(exported.out, "/api/hello  (src/routes/api/hello.ts) — a server route");
    assertStringIncludes(exported.out, "/notes  (src/routes/notes.tsx) — calls a server function");
    for (const missing of ["notes", "api", "boom"]) {
      assertEquals(
        await Deno.stat(join(out, missing)).then(() => true, () => false),
        false,
        `${missing} is not in the export`,
      );
    }
  });

  // A static host whose fallback is Start's SPA shell.
  const host = serveStatic(out, "_shell.html");
  const browser = await launchBrowser();
  try {
    await t.step("a path with no file gets the SPA shell, and the app renders it", async () => {
      const page = await browser.newPage(host.origin + "/");
      const errors = collectConsoleErrors(page);
      await hydrated(page);
      // The index route's loader ran in the browser: the shell rendered no route on the server.
      assertEquals(
        await textWhen(page, "#rendered-on", (t) => t.includes("browser")),
        "loader ran on the browser",
      );
      assert(host.served.includes("_shell.html"), "the fallback answered");
      assertNoConsoleErrors(errors);
      await page.close();
    });

    await t.step("a static page hydrates and navigates on the client", async () => {
      const page = await browser.newPage(host.origin + "/posts");
      const errors = collectConsoleErrors(page);
      await page.waitForSelector("#posts", { timeout: 20_000 });
      await hydrated(page);
      await page.evaluate(() => {
        (globalThis as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });
      await (await page.$('#posts a[href="/posts/2"]'))!.click();
      await page.waitForSelector("#posts-layout #post", { timeout: 15_000 });
      const state = await page.evaluate(() => ({
        path: location.pathname,
        sameDocument:
          (globalThis as unknown as { __sameDocument?: boolean }).__sameDocument === true,
        text: document.querySelector("#post")?.textContent ?? "",
      }));
      assertEquals(state.path, "/posts/2");
      assert(state.sameDocument, "a client navigation, not a document load");
      assertStringIncludes(state.text, "Then the router takes over");
      assertNoConsoleErrors(errors);
      await page.close();
    });

    await t.step(
      "with JavaScript off, the pages render and a link loads the next file",
      async () => {
        const page = await browser.newPage();
        // deno-lint-ignore no-explicit-any
        const cdp = page.unsafelyGetCelestialBindings() as any;
        await cdp.Emulation.setScriptExecutionDisabled({ value: true });
        host.served.length = 0;
        await page.goto(host.origin + "/posts", { waitUntil: "load" });
        const list = await page.evaluate(() => document.querySelector("#posts")?.textContent ?? "");
        assertStringIncludes(list, "Every page arrives rendered", "the list is in the HTML");
        const pages = () => host.served.filter((f) => f.endsWith(".html"));
        assertEquals(pages(), ["posts/index.html"]);
        // Marks this document: a full page load drops the mark, a client navigation keeps it.
        await page.evaluate(() => {
          (globalThis as unknown as { __sameDocument: boolean }).__sameDocument = true;
        });
        const navigated = page.waitForNavigation({ waitUntil: "load" });
        await (await page.$('#posts a[href="/posts/2"]'))!.click();
        await navigated;
        const state = await page.evaluate(() => ({
          path: location.pathname,
          sameDocument:
            (globalThis as unknown as { __sameDocument?: boolean }).__sameDocument === true,
          layout: !!document.querySelector("#posts-layout #post"),
          text: document.querySelector("#post")?.textContent ?? "",
        }));
        assertEquals(state.path, "/posts/2");
        assert(!state.sameDocument, "a full page load, not a client navigation");
        assert(state.layout, "the post renders inside its layout, from the exported HTML");
        assertStringIncludes(state.text, "Then the router takes over");
        assertEquals(pages(), ["posts/index.html", "posts/2/index.html"], "the exported file");
        await page.close();
      },
    );
  } finally {
    await browser.close();
    await host.close();
  }
});
