// `denext mcp`'s `denext_ui_*` tools (src/mcp/ui.ts): every `denext ui` panel as an MCP tool,
// sent through a real `denext ui` child's own security chain (loopback, token handshake, origin,
// CSRF, `--read-only`), with a change sent only as a preview or with `apply: true`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UI_ROUTES } from "../src/ui/routes.ts";
import { panelOf, UI_PANELS } from "../src/ui/panels.ts";
import { UI_TOOL_NAMES, UiBridge, uiCallRefusal, uiTools } from "../src/mcp/ui.ts";
import { TOOL_GROUPS, TOOLS } from "../src/mcp/tools.ts";

const generate = UI_PANELS.find((p) => p.id === "generate")!;

Deno.test("every page denext ui serves belongs to a panel tool (or the overview)", () => {
  const own = new Set(["/", "/api/overview"]);
  for (const path of Object.keys(UI_ROUTES)) {
    if (own.has(path) || path.startsWith("/_denext/") || path.startsWith("/_ui")) continue;
    const page = path.startsWith("/api/") ? path.slice(4) : path;
    if (!page.startsWith("/") || /\.(css|js)$/.test(page) || page === "/events") continue;
    assert(panelOf(page) !== null, `${path} has no denext_ui_* tool`);
  }
});

Deno.test("the ui tools are registered, in the `ui` group", () => {
  assertEquals(TOOL_GROUPS.ui, UI_TOOL_NAMES);
  for (const name of UI_TOOL_NAMES) assert(TOOLS.some((t) => t.name === name), name);
  assertEquals(UI_TOOL_NAMES.length, UI_PANELS.length + 1);
});

Deno.test("uiCallRefusal: reads go, a change needs a preview or apply, paths stay in the panel", () => {
  assertEquals(uiCallRefusal(generate, { path: "/generate", method: "GET" }, false), null);
  const change = { path: "/generate", method: "POST", fields: { kind: "page", name: "x" } };
  assertStringIncludes(uiCallRefusal(generate, change, false)!, "apply: true");
  assertEquals(uiCallRefusal(generate, change, true), null);
  const preview = { ...change, fields: { ...change.fields, op: "preview" } };
  assertEquals(uiCallRefusal(generate, preview, false), null);
  assertStringIncludes(
    uiCallRefusal(generate, { path: "/config", method: "GET" }, false)!,
    "not a page of the generate panel",
  );
  assertStringIncludes(
    uiCallRefusal(generate, { path: "/generate/../config", method: "GET" }, false)!,
    "path must be",
  );
  assertStringIncludes(
    uiCallRefusal(generate, { path: "/generate", method: "PUT" }, false)!,
    "method must be",
  );
});

/** A minimal project the UI can manage. */
async function project(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_mcp_ui_" }));
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ name: "mcp-ui-app" }));
  await Deno.mkdir(join(dir, "app"));
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    "export default function Page() { return <main />; }\n",
  );
  return dir;
}

Deno.test({
  name: "the tools drive a real denext ui child: overview, preview, refused change, apply",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await project();
  const tools = uiTools(() => dir);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  try {
    const overview = await tool("denext_ui_overview").run({});
    assertEquals(overview.isError, undefined, overview.text);
    assertStringIncludes(overview.text, '"name":"mcp-ui-app"');
    assertStringIncludes(overview.text, "/api/generate");

    const fields = { kind: "page", name: "about" };
    const refused = await tool("denext_ui_generate").run({ method: "POST", fields });
    assert(refused.isError);
    assertStringIncludes(refused.text, "apply: true");

    const preview = await tool("denext_ui_generate").run({
      method: "POST",
      fields: { ...fields, op: "preview" },
    });
    assertEquals(preview.isError, undefined, preview.text);
    assertStringIncludes(preview.text, "app/about/page.tsx");
    await Deno.stat(join(dir, "app", "about", "page.tsx")).then(
      () => assert(false, "a preview wrote the file"),
      () => {},
    );

    const applied = await tool("denext_ui_generate").run({
      method: "POST",
      fields: { ...fields, op: "apply" },
      apply: true,
    });
    assertEquals(applied.isError, undefined, applied.text);
    assert((await Deno.stat(join(dir, "app", "about", "page.tsx"))).isFile);
  } finally {
    const { stopUiBridges } = await import("../src/mcp/ui.ts");
    stopUiBridges();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "the bridge holds the UI's gates: --read-only refuses a change; no session, no answer",
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const dir = await project();
  const bridge = new UiBridge(dir, { readOnly: true });
  try {
    const reply = await bridge.request({
      path: "/generate",
      method: "POST",
      fields: { kind: "page", name: "x", op: "apply" },
    });
    assertEquals(reply.status, 403);
    assertStringIncludes(reply.text, "read-only");
    // A caller without the bridge's session gets nothing: the UI is token-gated.
    const res = await fetch(`${bridge.origin}/api/overview`);
    assertEquals(res.status, 401);
    await res.body?.cancel();
  } finally {
    bridge.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
