// Real-browser end-to-end test for @denext/pages-router client hydration + soft
// navigation. Builds examples/pages-router for production, serves it, and drives
// it with a headless Chromium (astral). This exercises what the in-memory handler
// tests can't: real hydration (state + events), SPA link navigation with no full
// reload, the soft-nav data endpoint (running getServerSideProps), a code-split
// chunk fetched on demand, and reconcile-in-place of the shared `_app` shell.
//
// Opt-in: run with `deno task test:e2e`. astral downloads Chromium on first run,
// so this is excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import { launchBrowser } from "./harness.ts";

const EXAMPLE = new URL("../../examples/pages-router", import.meta.url).pathname;
const CLI = new URL("../../cli.ts", import.meta.url).pathname;

/** A running server for the E2E suite. */
interface RunningServer {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Build + serve the example through the **CLI** (not the in-process `build()`),
 * so the CSS import-map re-exec (`maybeReexecForCss`) is active — the Pages Router
 * SSG step and SSR load page modules that `import "./x.css"`.
 */
async function buildAndServeViaCli(dir: string): Promise<RunningServer> {
  const deno = Deno.execPath();
  const build = await new Deno.Command(deno, {
    args: ["run", "-A", CLI, "build", "."],
    cwd: dir,
    stderr: "piped",
    stdout: "null",
  }).output();
  if (!build.success) {
    throw new Error(
      "denext build failed:\n" + new TextDecoder().decode(build.stderr),
    );
  }
  // Grab a free port, then start the prod server on it.
  const probe = Deno.listen({ port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const child = new Deno.Command(deno, {
    args: ["run", "-A", CLI, "start", ".", "--port", String(port)],
    cwd: dir,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const origin = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(origin + "/_denext/health");
      await r.body?.cancel();
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    origin,
    close: async () => {
      child.kill();
      await child.status;
    },
  };
}

Deno.test({
  name: "e2e: pages-router hydrates, is interactive, and soft-navigates (SSR data + code-split)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServeViaCli(EXAMPLE);
  const browser = await launchBrowser();

  try {
    await t.step(
      "server HTML is server-rendered and carries __NEXT_DATA__ + a hydration script",
      async () => {
        const html = await (await fetch(server.origin + "/")).text();
        assertStringIncludes(html, 'class="home"');
        assertStringIncludes(html, "Clicked 0 times");
        assertStringIncludes(html, 'id="__NEXT_DATA__"');
        assertStringIncludes(
          html,
          '<script type="module" src="/_denext/pages/',
        );
      },
    );

    await t.step(
      "App Router routes still win over the Pages Router",
      async () => {
        const html = await (await fetch(server.origin + "/app-page")).text();
        assertStringIncludes(html, 'class="app-only"');
        assert(
          !html.includes('id="__NEXT_DATA__"'),
          "an App Router route is not a Pages Router page",
        );
      },
    );

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const detail = (e as any).detail;
      if (detail?.type === "error") {
        consoleErrors.push(String(detail.text ?? ""));
      }
    });

    await t.step(
      "hydration completes (the runtime sets its hydrated marker)",
      async () => {
        await page.waitForFunction(
          "document.documentElement.getAttribute('data-denext-pages-hydrated') === '1'",
        );
      },
    );

    await t.step(
      "CSS: global stylesheet + CSS Module class are applied",
      async () => {
        // Global CSS from _app styles the shared shell (gray background).
        const shellBg = await page.evaluate(
          "getComputedStyle(document.querySelector('.shell')).backgroundColor",
        );
        assertStringIncludes(String(shellBg), "240, 240, 240");
        // The CSS Module class (hashed) colors the badge blue.
        const badgeColor = await page.evaluate(
          "getComputedStyle(document.querySelector('[data-testid=\"badge\"]')).color",
        );
        assertStringIncludes(String(badgeColor), "10, 90, 200");
      },
    );

    await t.step("next/head: the page title comes from <Head>", async () => {
      const title = await page.evaluate("document.title");
      assertStringIncludes(String(title), "Home PR");
    });

    await t.step(
      "next/head: a JSON-LD <script> is hoisted into <head>, not the body",
      async () => {
        // SSR: the script must land inside <head> (before </head>), not in the body.
        const html = await (await fetch(server.origin + "/")).text();
        const headEnd = html.indexOf("</head>");
        const scriptAt = html.indexOf("application/ld+json");
        assert(
          scriptAt !== -1 && scriptAt < headEnd,
          "JSON-LD hoisted into <head> during SSR",
        );
        // Live DOM: exactly one JSON-LD script, in document.head (no hydration dupe).
        const inHead = await page.evaluate(
          "document.head.querySelectorAll('script[type=\"application/ld+json\"]').length",
        );
        assertStringIncludes(String(inHead), "1");
        const inBody = await page.evaluate(
          "document.body.querySelectorAll('script[type=\"application/ld+json\"]').length",
        );
        assertStringIncludes(String(inBody), "0");
      },
    );

    await t.step("the counter is interactive after hydration", async () => {
      const button = await page.$("button");
      assert(button, "counter button should exist");
      await button.click();
      const label = await page.evaluate(
        "document.querySelector('button') ? document.querySelector('button').textContent : ''",
      );
      assertStringIncludes(String(label), "Clicked 1 time");
    });

    await t.step(
      "clicking a <Link> soft-navigates (SPA, no full reload)",
      async () => {
        // A full reload would wipe these markers; a soft nav preserves them.
        await page.evaluate("window.__prNoReload = true");
        await page.evaluate(
          "document.querySelector('.shell').__prMark = 'kept'",
        );
        await page.evaluate(
          "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'About').click()",
        );
        await page.waitForFunction(
          "location.pathname === '/about' && !!document.querySelector('.about')",
        );
        const survived = await page.evaluate("window.__prNoReload === true");
        assert(
          survived,
          "client navigation must not trigger a full page reload",
        );
        const shellKept = await page.evaluate(
          "document.querySelector('.shell') && document.querySelector('.shell').__prMark === 'kept'",
        );
        assert(
          shellKept,
          "the shared _app shell must be reconciled in place, not remounted",
        );
        // next/head updates document.title across soft navigation.
        await page.waitForFunction("document.title === 'About PR'");
        // The About route's own CSS Module must be injected on soft nav (its stylesheet
        // wasn't present on the initial Home load) — otherwise this element is unstyled.
        await page.waitForFunction(
          "document.querySelector('[data-testid=\"about-tag\"]') && " +
            "getComputedStyle(document.querySelector('[data-testid=\"about-tag\"]')).color === 'rgb(200, 30, 40)'",
        );
      },
    );

    await t.step(
      "soft nav to a getServerSideProps route fetches data + a code-split chunk",
      async () => {
        // From /about, navigate Home then to the gSSP post — its props come from
        // the server data endpoint and its component from a lazily-imported chunk.
        await page.evaluate(
          "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Home').click()",
        );
        await page.waitForFunction(
          "location.pathname === '/' && !!document.querySelector('.home')",
        );
        await page.evaluate(
          "Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Post').click()",
        );
        await page.waitForFunction(
          "location.pathname === '/blog/hello' && !!document.querySelector('.post')",
        );
        const text = await page.evaluate(
          "document.querySelector('.post').textContent",
        );
        assertStringIncludes(String(text), "Post: hello (gssp)");
        const stillSpa = await page.evaluate("window.__prNoReload === true");
        assert(stillSpa, "data-driven soft nav must not reload the page");
      },
    );

    await t.step(
      "browser back button restores the previous route",
      async () => {
        await page.evaluate("history.back()");
        await page.waitForFunction(
          "location.pathname === '/' && !!document.querySelector('.home')",
        );
      },
    );

    await t.step(
      "SSG: a prerendered getStaticProps page serves + hydrates",
      async () => {
        const html = await (await fetch(server.origin + "/ssg/1")).text();
        assertStringIncludes(html, "SSG #1 (static)"); // served from the prerendered file
        const ssg = await browser.newPage(server.origin + "/ssg/1");
        try {
          await ssg.waitForFunction(
            "document.documentElement.getAttribute('data-denext-pages-hydrated') === '1'",
          );
        } finally {
          await ssg.close();
        }
      },
    );

    await t.step(
      "fallback:true: an unlisted path shows a shell, then hydrates real props",
      async () => {
        // SSR of an UNLISTED id serves the props-less shell (isFallback → "Loading…").
        const html = await (await fetch(server.origin + "/product/xyz")).text();
        assertStringIncludes(html, "Loading…");
        assertStringIncludes(html, '"isFallback":true');
        // In the browser, the client fetches getStaticProps and swaps in real props.
        const prod = await browser.newPage(server.origin + "/product/xyz");
        try {
          await prod.waitForFunction(
            "document.querySelector('.product') && " +
              "document.querySelector('.product').textContent.includes('Product xyz')",
          );
        } finally {
          await prod.close();
        }
        // A LISTED id is prerendered with its props (no shell).
        const known = await (await fetch(server.origin + "/product/known"))
          .text();
        assertStringIncludes(known, "Product known");
      },
    );

    await t.step("custom 404 renders for an unknown page path", async () => {
      const res = await fetch(server.origin + "/no-such-page");
      assertStringIncludes(String(res.status), "404");
      assertStringIncludes(await res.text(), "This page could not be found");
    });

    await t.step("no console errors during hydration and navigation", () => {
      assert(
        consoleErrors.length === 0,
        `unexpected console errors: ${consoleErrors.join(" | ")}`,
      );
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
