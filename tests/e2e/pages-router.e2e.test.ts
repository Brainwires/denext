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
import type { Browser, Page } from "@astral/astral";
import {
  assertNoConsoleErrors,
  clickCounterAndExpectOne,
  clickLinkByText,
  collectConsoleErrors,
  launchBrowser,
  type RunningServer,
} from "./harness.ts";

const EXAMPLE = new URL("../../examples/pages-router", import.meta.url).pathname;
const CLI = new URL("../../cli.ts", import.meta.url).pathname;

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

const HYDRATED_MARKER =
  "document.documentElement.getAttribute('data-denext-pages-hydrated') === '1'";

/** Open `url` in a fresh page, wait for `expr` to hold, then close the page. */
async function inNewPage(browser: Browser, url: string, expr: string): Promise<void> {
  const page = await browser.newPage(url);
  try {
    await page.waitForFunction(expr);
  } finally {
    await page.close();
  }
}

async function stepServerHtml(server: RunningServer): Promise<void> {
  const html = await (await fetch(server.origin + "/")).text();
  assertStringIncludes(html, 'class="home"');
  assertStringIncludes(html, "Clicked 0 times");
  assertStringIncludes(html, 'id="__NEXT_DATA__"');
  assertStringIncludes(
    html,
    '<script type="module" src="/_denext/pages/',
  );
}

async function stepAppRouterWins(server: RunningServer): Promise<void> {
  const html = await (await fetch(server.origin + "/app-page")).text();
  assertStringIncludes(html, 'class="app-only"');
  assert(
    !html.includes('id="__NEXT_DATA__"'),
    "an App Router route is not a Pages Router page",
  );
}

/** Everything the page-driven steps below can reach. */
interface Ctx {
  server: RunningServer;
  browser: Browser;
  page: Page;
  consoleErrors: string[];
}

async function stepCssApplied({ page }: Ctx): Promise<void> {
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
}

async function stepHeadTitle({ page }: Ctx): Promise<void> {
  const title = await page.evaluate("document.title");
  assertStringIncludes(String(title), "Home PR");
}

async function stepJsonLdHoisted({ server, page }: Ctx): Promise<void> {
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
}

async function stepSoftNavAbout({ page }: Ctx): Promise<void> {
  // A full reload would wipe these markers; a soft nav preserves them.
  await page.evaluate("window.__prNoReload = true");
  await page.evaluate(
    "document.querySelector('.shell').__prMark = 'kept'",
  );
  await clickLinkByText(page, "About");
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
}

async function stepSoftNavGssp({ page }: Ctx): Promise<void> {
  // From /about, navigate Home then to the gSSP post — its props come from
  // the server data endpoint and its component from a lazily-imported chunk.
  await clickLinkByText(page, "Home");
  await page.waitForFunction(
    "location.pathname === '/' && !!document.querySelector('.home')",
  );
  await clickLinkByText(page, "Post");
  await page.waitForFunction(
    "location.pathname === '/blog/hello' && !!document.querySelector('.post')",
  );
  const text = await page.evaluate(
    "document.querySelector('.post').textContent",
  );
  assertStringIncludes(String(text), "Post: hello (gssp)");
  const stillSpa = await page.evaluate("window.__prNoReload === true");
  assert(stillSpa, "data-driven soft nav must not reload the page");
}

async function stepBack({ page }: Ctx): Promise<void> {
  await page.evaluate("history.back()");
  await page.waitForFunction(
    "location.pathname === '/' && !!document.querySelector('.home')",
  );
}

async function stepSsg({ server, browser }: Ctx): Promise<void> {
  const html = await (await fetch(server.origin + "/ssg/1")).text();
  assertStringIncludes(html, "SSG #1 (static)"); // served from the prerendered file
  await inNewPage(browser, server.origin + "/ssg/1", HYDRATED_MARKER);
}

async function stepFallback({ server, browser }: Ctx): Promise<void> {
  // SSR of an UNLISTED id serves the props-less shell (isFallback → "Loading…").
  const html = await (await fetch(server.origin + "/product/xyz")).text();
  assertStringIncludes(html, "Loading…");
  assertStringIncludes(html, '"isFallback":true');
  // In the browser, the client fetches getStaticProps and swaps in real props.
  await inNewPage(
    browser,
    server.origin + "/product/xyz",
    "document.querySelector('.product') && " +
      "document.querySelector('.product').textContent.includes('Product xyz')",
  );
  // A LISTED id is prerendered with its props (no shell).
  const known = await (await fetch(server.origin + "/product/known"))
    .text();
  assertStringIncludes(known, "Product known");
}

async function stepCustom404({ server }: Ctx): Promise<void> {
  const res = await fetch(server.origin + "/no-such-page");
  assertStringIncludes(String(res.status), "404");
  assertStringIncludes(await res.text(), "This page could not be found");
}

/** The page-driven steps, in order (each runs against the same hydrated home page). */
const PAGE_STEPS: Array<[string, (ctx: Ctx) => Promise<void> | void]> = [
  [
    "hydration completes (the runtime sets its hydrated marker)",
    async ({ page }) => {
      await page.waitForFunction(HYDRATED_MARKER);
    },
  ],
  ["CSS: global stylesheet + CSS Module class are applied", stepCssApplied],
  ["next/head: the page title comes from <Head>", stepHeadTitle],
  ["next/head: a JSON-LD <script> is hoisted into <head>, not the body", stepJsonLdHoisted],
  ["the counter is interactive after hydration", ({ page }) => clickCounterAndExpectOne(page)],
  ["clicking a <Link> soft-navigates (SPA, no full reload)", stepSoftNavAbout],
  ["soft nav to a getServerSideProps route fetches data + a code-split chunk", stepSoftNavGssp],
  ["browser back button restores the previous route", stepBack],
  ["SSG: a prerendered getStaticProps page serves + hydrates", stepSsg],
  ["fallback:true: an unlisted path shows a shell, then hydrates real props", stepFallback],
  ["custom 404 renders for an unknown page path", stepCustom404],
  [
    "no console errors during hydration and navigation",
    ({ consoleErrors }) => assertNoConsoleErrors(consoleErrors),
  ],
];

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
      () => stepServerHtml(server),
    );
    await t.step(
      "App Router routes still win over the Pages Router",
      () => stepAppRouterWins(server),
    );

    const page = await browser.newPage(server.origin + "/");
    const ctx: Ctx = { server, browser, page, consoleErrors: collectConsoleErrors(page) };
    for (const [name, fn] of PAGE_STEPS) await t.step(name, () => fn(ctx));
  } finally {
    await browser.close();
    await server.close();
  }
});
