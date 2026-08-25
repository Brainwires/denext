import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../mod.ts";
import {
  htmlResponse,
  Htmx,
  htmx,
  HTMX_RUNTIME_PATH,
  HTMX_VERSION,
  htmxRequest,
  hx,
  isHtmxRequest,
} from "../packages/htmx/mod.ts";
import { htmxCommand } from "../packages/htmx/command.ts";
import type { DenextConfig } from "../src/server/config.ts";
import type { ModuleLoader } from "../src/server/types.ts";
import {
  applyPlugins,
  getPluginCommands,
  getPluginRequestHandler,
  resetPlugins,
  runPluginBuildSteps,
} from "../src/plugin/mod.ts";

const noopLoad = (() => Promise.resolve({})) as unknown as ModuleLoader;

function applyHtmx(config: Partial<DenextConfig> = {}) {
  return applyPlugins({
    projectRoot: "/tmp/proj",
    appDir: "/tmp/proj/app",
    config: { plugins: [htmx()], ...config } as DenextConfig,
    mode: "prod",
    load: noopLoad,
  });
}

// --- hx() attribute helper --------------------------------------------------

Deno.test("hx() maps un-prefixed keys to hx-* attributes", () => {
  const attrs = hx({ post: "/clicked", swap: "outerHTML", target: "#result" });
  assertEquals(attrs, {
    "hx-post": "/clicked",
    "hx-swap": "outerHTML",
    "hx-target": "#result",
  });
});

Deno.test("hx() kebab-cases camelCase keys and stringifies booleans", () => {
  const attrs = hx({ swapOob: true, pushUrl: "/x", boost: true });
  assertEquals(attrs, { "hx-swap-oob": "true", "hx-push-url": "/x", "hx-boost": "true" });
});

Deno.test("hx() expands `on` into hx-on:<event> and drops undefined/false", () => {
  const attrs = hx({
    on: { click: "alert(1)", "htmx:afterRequest": "x()" },
    boost: false,
    get: undefined,
  });
  assertEquals(attrs, { "hx-on:click": "alert(1)", "hx-on:htmx:afterRequest": "x()" });
});

// --- <Htmx/> component ------------------------------------------------------

Deno.test("<Htmx/> renders a deferred script tag for the runtime path", async () => {
  const html = await renderToString(h(Htmx, {}));
  assertStringIncludes(html, `src="${HTMX_RUNTIME_PATH}"`);
  assertStringIncludes(html, "<script");
  assert(/defer/.test(html), "script is deferred");
});

Deno.test("<Htmx/> honors a custom src and nonce", async () => {
  const html = await renderToString(h(Htmx, { src: "/vendor/htmx.js", nonce: "abc123" }));
  assertStringIncludes(html, `src="/vendor/htmx.js"`);
  assertStringIncludes(html, `nonce="abc123"`);
});

// --- request parsing --------------------------------------------------------

Deno.test("isHtmxRequest / htmxRequest parse HX-* request headers", () => {
  const req = new Request("https://x/", {
    headers: {
      "HX-Request": "true",
      "HX-Boosted": "true",
      "HX-Current-URL": "https://x/page",
      "HX-Target": "result",
      "HX-Trigger": "btn",
      "HX-Trigger-Name": "save",
      "HX-Prompt": "hello",
    },
  });
  assert(isHtmxRequest(req));
  const info = htmxRequest(req);
  assertEquals(info.isHtmx, true);
  assertEquals(info.boosted, true);
  assertEquals(info.currentUrl, "https://x/page");
  assertEquals(info.target, "result");
  assertEquals(info.triggerId, "btn");
  assertEquals(info.triggerName, "save");
  assertEquals(info.prompt, "hello");
});

Deno.test("isHtmxRequest is false for a normal request", () => {
  assert(!isHtmxRequest(new Request("https://x/")));
});

// --- htmlResponse -----------------------------------------------------------

Deno.test("htmlResponse renders a VNode and sets HX-* response headers", async () => {
  const res = await htmlResponse(h("span", {}, "Clicked!"), {
    retarget: "#result",
    reswap: "beforeend",
  });
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(res.headers.get("HX-Retarget"), "#result");
  assertEquals(res.headers.get("HX-Reswap"), "beforeend");
  assertStringIncludes(await res.text(), "Clicked!");
});

Deno.test("htmlResponse serializes an object trigger as JSON and accepts a string body", async () => {
  const res = await htmlResponse("<b>ok</b>", {
    trigger: { showToast: { level: "info" } },
    refresh: true,
  });
  assertEquals(res.headers.get("HX-Trigger"), '{"showToast":{"level":"info"}}');
  assertEquals(res.headers.get("HX-Refresh"), "true");
  assertEquals(await res.text(), "<b>ok</b>");
});

// --- plugin: request handler ------------------------------------------------

Deno.test("htmx plugin serves the vendored runtime from 'self'", async () => {
  resetPlugins();
  try {
    await applyHtmx();
    const handle = getPluginRequestHandler();
    assert(handle, "plugin registered a request handler");
    const res = await handle!(new Request(`https://x${HTMX_RUNTIME_PATH}`));
    assert(res, "runtime path is served");
    assertEquals(res!.status, 200);
    assertEquals(res!.headers.get("content-type"), "text/javascript; charset=utf-8");
    assertEquals(res!.headers.get("etag"), `"htmx-${HTMX_VERSION}"`);
    const body = await res!.text();
    assertStringIncludes(body, "htmx", "served body is the htmx runtime");
  } finally {
    resetPlugins();
  }
});

Deno.test("htmx plugin answers a conditional GET with 304", async () => {
  resetPlugins();
  try {
    await applyHtmx();
    const handle = getPluginRequestHandler()!;
    const res = await handle(
      new Request(`https://x${HTMX_RUNTIME_PATH}`, {
        headers: { "If-None-Match": `"htmx-${HTMX_VERSION}"` },
      }),
    );
    assertEquals(res!.status, 304);
  } finally {
    resetPlugins();
  }
});

Deno.test("htmx plugin passes through unrelated requests", async () => {
  resetPlugins();
  try {
    await applyHtmx();
    const handle = getPluginRequestHandler()!;
    const res = await handle(new Request("https://x/some/page"));
    assertEquals(res, null);
  } finally {
    resetPlugins();
  }
});

Deno.test("htmx plugin respects basePath", async () => {
  resetPlugins();
  try {
    await applyHtmx({ basePath: "/app" });
    const handle = getPluginRequestHandler()!;
    assertEquals(await handle(new Request(`https://x${HTMX_RUNTIME_PATH}`)), null);
    const res = await handle(new Request(`https://x/app${HTMX_RUNTIME_PATH}`));
    assertEquals(res!.status, 200);
  } finally {
    resetPlugins();
  }
});

// --- plugin: build step + command ------------------------------------------

Deno.test("htmx plugin emits the runtime into the export output", async () => {
  resetPlugins();
  const outDir = await Deno.makeTempDir({ prefix: "denext_htmx_" });
  try {
    await applyHtmx();
    await runPluginBuildSteps({
      projectRoot: "/tmp/proj",
      appDir: "/tmp/proj/app",
      outDir,
      config: { plugins: [htmx()] } as DenextConfig,
    });
    const stat = await Deno.stat(join(outDir, "_denext", "htmx", "htmx.min.js"));
    assert(stat.isFile && stat.size > 1000, "runtime was written to outDir");
  } finally {
    resetPlugins();
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("htmx plugin contributes the `denext htmx` verb", async () => {
  resetPlugins();
  try {
    await applyHtmx();
    const names = getPluginCommands().map((c) => c.name);
    assert(names.includes("htmx"), "registers the htmx command");
    assertEquals(htmxCommand.name, "htmx");
  } finally {
    resetPlugins();
  }
});
