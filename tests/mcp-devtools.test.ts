// The DevTools → MCP bridge (B12): the in-page sink, the dev endpoint that stores what it
// posts, and the three MCP tools that render it.
//
// The load-bearing server assertions are the refusals. `/_denext/dev-inspect` is the first
// dev endpoint that STORES browser-supplied structured data, so it must refuse a
// cross-origin caller (403, inherited from the gated switch — cf. CVE-2025-48068), a wrong
// method (405), a non-JSON body (415) and an oversized one (413), and it must DROP a
// malformed body silently (204) rather than keep junk an MCP tool would later read
// straight into an agent's context.
//
// The client assertions are about the three caps that make the push safe: one post per
// throttle window however many commits happened, no raw values in the payload, and an
// honest `truncated` when a cap bit.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { resolveProject } from "../src/build/paths.ts";
import { createDevHandler } from "../src/build/dev-server/handler.ts";
import {
  createDevState,
  DEV_INSPECT_PATH,
  type DevState,
  MAX_INSPECT_URLS,
} from "../src/build/dev-server/state.ts";
import { defaultLoader } from "../src/server/mod.ts";
import {
  buildSnapshot,
  type InspectSnapshot,
  type InspectSnapshotNode,
  installInspectSink,
} from "../src/client/devtools-inspect-sink.ts";
import type { DenextDevtoolsApi, InspectNode } from "../src/client/devtools-inspect.ts";
import { componentTreeText, hookStateText, missText, whyRenderText } from "../src/mcp/devtools.ts";
import { fetchDevInspect } from "../src/mcp/dev-client.ts";
import { runTool, TOOL_GROUPS, TOOLS } from "../src/mcp/tools.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

// ---- server: the sink + the read ------------------------------------------------------

/** A throwaway project the dev handler can be built over (no routes are needed here). */
async function tempApp(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_mcp_devtools_" });
  await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({ imports: {} }));
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app", "page.tsx"),
    "export default function Page(){return null}\n",
  );
  await Deno.mkdir(join(dir, ".denext"), { recursive: true });
  return dir;
}

/** A dev handler plus the state it writes snapshots into. */
async function devHandler(
  dir: string,
): Promise<{ handle: (req: Request) => Promise<Response>; st: DevState }> {
  const st = createDevState({ paths: await resolveProject(dir), unbundled: false });
  st.load = defaultLoader;
  return { handle: createDevHandler(st, () => Promise.resolve(new Response("app"))), st };
}

/** A minimal valid snapshot for `url`. */
function fixtureSnapshot(url = "/"): InspectSnapshot {
  return {
    url,
    at: Date.now(),
    truncated: false,
    nodes: [{
      id: 1,
      name: "Page",
      key: null,
      props: { preview: "{}", type: "object" },
      hooks: [],
      contexts: [],
      children: [],
    }],
  };
}

/** POST a snapshot (or a raw body) to the sink, same-origin. */
function postSnapshot(
  handle: (req: Request) => Promise<Response>,
  body: string | InspectSnapshot,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handle(
    new Request(`http://localhost${DEV_INSPECT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** GET the sink's read side, same-origin. */
function readSnapshot(
  handle: (req: Request) => Promise<Response>,
  query = "",
): Promise<Response> {
  return handle(
    new Request(`http://localhost${DEV_INSPECT_PATH}${query}`, {
      headers: { "sec-fetch-site": "same-origin" },
    }),
  );
}

Deno.test("dev-inspect: the endpoint's path is spelled the same on both sides", () => {
  // The page sink and the MCP client each carry a LITERAL copy of the path (neither may
  // import from `src/build/dev-server/`); the sink's copy is asserted through the URL it
  // posts to, below, and the MCP client's here.
  assertEquals(DEV_INSPECT_PATH, "/_denext/dev-inspect");
  assertStringIncludes(
    Deno.readTextFileSync(new URL("../src/mcp/dev-client.ts", import.meta.url)),
    `const DEV_INSPECT_PATH = "${DEV_INSPECT_PATH}"`,
  );
});

Deno.test({
  name: "dev-inspect: a posted snapshot round-trips through the GET read with an age",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle } = await devHandler(dir);
    assertEquals((await readSnapshot(handle)).status, 404, "nothing posted yet");
    const empty = await readSnapshot(handle);
    assertEquals((await empty.json()).reason, "no_snapshot");

    const posted = await postSnapshot(handle, fixtureSnapshot("/blog?x=1"));
    assertEquals(posted.status, 204);

    const res = await readSnapshot(handle);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assertEquals(body.snapshot.url, "/blog?x=1");
    assertEquals(body.snapshot.nodes[0].name, "Page");
    assert(body.ageMs >= 0 && body.ageMs < 10_000, `plausible ageMs, got ${body.ageMs}`);

    // `?url=` selects a page — exact, and by path when only the query differs.
    assertEquals(
      (await (await readSnapshot(handle, "?url=/blog%3Fx=1")).json()).snapshot.url,
      "/blog?x=1",
    );
    assertEquals(
      (await (await readSnapshot(handle, "?url=/blog")).json()).snapshot.url,
      "/blog?x=1",
    );
    assertEquals((await readSnapshot(handle, "?url=/nope")).status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-inspect: cross-origin POST and GET are both refused (403)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle, st } = await devHandler(dir);
    for (const site of ["cross-site", "same-site", "none"]) {
      const post = await postSnapshot(handle, fixtureSnapshot(), { "sec-fetch-site": site });
      assertEquals(post.status, 403, `POST must refuse Sec-Fetch-Site: ${site}`);
      assertEquals(await post.text(), "forbidden");
      const get = await readSnapshot(handle, "");
      await get.body?.cancel();
    }
    const crossGet = await handle(
      new Request(`http://localhost${DEV_INSPECT_PATH}`, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    assertEquals(crossGet.status, 403);
    assertEquals(await crossGet.text(), "forbidden");
    // A hostile page's Origin is refused even without Sec-Fetch-Site…
    const origin = await handle(
      new Request(`http://localhost${DEV_INSPECT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify(fixtureSnapshot()),
      }),
    );
    assertEquals(origin.status, 403);
    // …and nothing a refused caller sent was stored.
    assertEquals(st.devInspect.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-inspect: wrong method (405), wrong type (415) and an oversized body (413)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle, st } = await devHandler(dir);
    const put = await handle(
      new Request(`http://localhost${DEV_INSPECT_PATH}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(fixtureSnapshot()),
      }),
    );
    assertEquals(put.status, 405);
    assertEquals(put.headers.get("allow"), "GET, POST");

    const wrongType = await postSnapshot(handle, fixtureSnapshot(), {
      "content-type": "text/plain",
    });
    assertEquals(wrongType.status, 415);

    // Both cap paths: a declared content-length over the cap, and a body that only turns
    // out to be oversized as it is read.
    const declared = await postSnapshot(handle, fixtureSnapshot("/declared"), {
      "content-length": "999999",
    });
    assertEquals(declared.status, 413);
    const huge = fixtureSnapshot("/huge");
    huge.nodes[0].props = { preview: "x".repeat(300 * 1024), type: "string" };
    const tooBig = await postSnapshot(handle, huge);
    assertEquals(tooBig.status, 413);

    assertEquals(st.devInspect.size, 0, "a refused request stores nothing");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-inspect: a malformed or mis-shaped body is dropped silently (204, nothing stored)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle, st } = await devHandler(dir);
    for (
      const body of [
        "{not json",
        "[]",
        JSON.stringify({ nodes: [] }), // no url
        JSON.stringify({ url: "/", nodes: [{ id: "one", name: "Page" }] }), // bad node
        JSON.stringify({ url: "/", nodes: [{ id: 1, name: "P", props: {}, hooks: [] }] }), // no children
      ]
    ) {
      assertEquals((await postSnapshot(handle, body)).status, 204, `dropped: ${body.slice(0, 20)}`);
    }
    assertEquals(st.devInspect.size, 0);
    assertEquals((await readSnapshot(handle)).status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-inspect: the per-URL store is an LRU that evicts the oldest page",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle, st } = await devHandler(dir);
    for (let i = 0; i <= MAX_INSPECT_URLS; i++) {
      assertEquals((await postSnapshot(handle, fixtureSnapshot(`/p${i}`))).status, 204);
    }
    assertEquals(st.devInspect.size, MAX_INSPECT_URLS);
    assertEquals((await readSnapshot(handle, "?url=/p0")).status, 404, "oldest evicted");
    assertEquals((await readSnapshot(handle, "?url=/p1")).status, 200);
    const newest = await (await readSnapshot(handle)).json();
    assertEquals(newest.snapshot.url, `/p${MAX_INSPECT_URLS}`, "the read defaults to the newest");
    // Re-posting an existing page refreshes its recency instead of adding an entry.
    await postSnapshot(handle, fixtureSnapshot("/p1"));
    assertEquals(st.devInspect.size, MAX_INSPECT_URLS);
    assertEquals((await (await readSnapshot(handle)).json()).snapshot.url, "/p1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- the MCP tools' text --------------------------------------------------------------

/** A two-level fixture: a Page with a named-hook Counter and an unnamed-hook Legacy child. */
function treeFixture(): InspectSnapshot {
  const counter: InspectSnapshotNode = {
    id: 2,
    name: "Counter",
    key: "a",
    badges: ["memo"],
    props: { preview: "{label}", type: "object", size: 1 },
    hooks: [
      {
        index: 0,
        kind: "state",
        value: { preview: "3", type: "number" },
        editable: true,
        name: "count",
        hook: "useState",
      },
      {
        index: 1,
        kind: "effect",
        value: { preview: "ƒ anonymous", type: "function" },
        editable: false,
        deps: [{ preview: "3", type: "number" }],
        hasCleanup: true,
        name: "",
        hook: "useEffect",
      },
    ],
    contexts: [{ name: "Theme", value: { preview: '"dark"', type: "string" } }],
    source: { file: "file:///proj/app/counter.tsx", line: 5, column: 1, export: "Counter" },
    hooksNamed: true,
    reason: { props: ["label"], hooks: [0], contexts: ["Theme"], count: 4 },
    children: [],
  };
  const legacy: InspectSnapshotNode = {
    id: 3,
    name: "Legacy",
    key: null,
    props: { preview: "{}", type: "object" },
    hooks: [{ index: 0, kind: "state", value: { preview: "1", type: "number" }, editable: true }],
    contexts: [],
    hooksNamed: false,
    children: [],
  };
  return {
    url: "/",
    at: Date.now(),
    truncated: false,
    nodes: [{
      id: 1,
      name: "Page",
      key: null,
      props: { preview: "{}", type: "object" },
      hooks: [],
      contexts: [],
      source: { file: "file:///proj/app/page.tsx", line: 12 },
      children: [counter, legacy],
    }],
  };
}

Deno.test("componentTreeText: header, indentation, source, badges and render count", () => {
  const text = componentTreeText({ snapshot: treeFixture(), ageMs: 420 }, { dir: "/proj" });
  const lines = text.split("\n");
  assertEquals(lines[0], "snapshot 0.4s old · /");
  assertEquals(lines[1], "Page  app/page.tsx:12");
  assertEquals(lines[2], '  Counter key="a" [memo]  app/counter.tsx:5  ×4');
  assertEquals(lines[3], "  Legacy");
  assert(!text.includes("interact with the page"), "a fresh snapshot carries no refresh hint");
});

Deno.test("componentTreeText: a stale snapshot says how to refresh it", () => {
  const text = componentTreeText({ snapshot: treeFixture(), ageMs: 42_000 });
  assertStringIncludes(text, "snapshot 42.0s old · /");
  assertStringIncludes(text, "— interact with the page or reload to refresh");
});

Deno.test("componentTreeText: filter keeps ancestors, depth and maxNodes cut the tree", () => {
  const inspect = { snapshot: treeFixture(), ageMs: 100 };
  const filtered = componentTreeText(inspect, { filter: "counter", dir: "/proj" });
  assertStringIncludes(filtered, "Page");
  assertStringIncludes(filtered, "Counter");
  assert(!filtered.includes("Legacy"), "a non-matching sibling is pruned");

  const shallow = componentTreeText(inspect, { depth: 1 });
  assertEquals(shallow.split("\n").length, 3, "root + the 'more not shown' note");
  assertStringIncludes(shallow, "…more components not shown");

  const capped = componentTreeText(inspect, { maxNodes: 2 });
  assert(!capped.includes("Legacy"));
  assertStringIncludes(capped, "…more components not shown");
});

Deno.test("componentTreeText: a page-truncated snapshot says so", () => {
  const snapshot = treeFixture();
  snapshot.truncated = true;
  assertStringIncludes(
    componentTreeText({ snapshot, ageMs: 10 }),
    "…the page capped this tree when it posted it",
  );
});

Deno.test("whyRenderText: names the changed props, hooks and contexts", () => {
  const text = whyRenderText({ snapshot: treeFixture(), ageMs: 100 }, "Counter", "/proj");
  assertStringIncludes(text, "Counter #2  app/counter.tsx:5 · rendered 4× while tracking");
  assertStringIncludes(text, "  props changed: label");
  assertStringIncludes(text, "  hook changed: [0] count · useState");
  assertStringIncludes(text, "  contexts changed: Theme");
});

Deno.test("whyRenderText: a component with no recorded reason says so", () => {
  const text = whyRenderText({ snapshot: treeFixture(), ageMs: 100 }, "Legacy");
  assertStringIncludes(text, "no render reason recorded yet");
});

Deno.test("hookStateText: every cell, one cell by index, and the unnamed-hooks note", () => {
  const inspect = { snapshot: treeFixture(), ageMs: 100 };
  const all = hookStateText(inspect, "Counter", undefined, "/proj");
  assertStringIncludes(all, "Counter #2  app/counter.tsx:5");
  assertStringIncludes(all, "  [0] count · useState = 3");
  assertStringIncludes(all, "  [1] useEffect = ƒ anonymous  deps [3]  (has cleanup)");

  const one = hookStateText(inspect, "Counter", 1);
  assert(!one.includes("[0] count"), "only the requested index is shown");
  assertStringIncludes(one, "[1] useEffect");
  assertStringIncludes(hookStateText(inspect, "Counter", 9), "no hook at index 9 (it has 2)");

  const legacy = hookStateText(inspect, "Legacy");
  assertStringIncludes(legacy, "names unavailable (conditional hooks?)");
  assertStringIncludes(legacy, "  [0] state = 1");
});

Deno.test("the three failure strings are distinct and each names its own fix", () => {
  const noServer = missText("no-dev-server", "/proj");
  const noSnapshot = missText("no-snapshot", "/proj");
  assertStringIncludes(noServer, "no dev server running (`deno task dev`)");
  assertStringIncludes(
    noSnapshot,
    "open the app in a browser — the DevTools sink has posted nothing yet",
  );
  assert(noServer !== noSnapshot);

  const inspect = { snapshot: treeFixture(), ageMs: 100 };
  for (
    const text of [
      componentTreeText(inspect, { filter: "Nope" }),
      whyRenderText(inspect, "Nope"),
      hookStateText(inspect, "Nope"),
    ]
  ) {
    assertStringIncludes(text, 'no component named "Nope"');
    assertStringIncludes(text, "Components present: Page, Counter, Legacy");
  }
});

// ---- registration + the no-dev-server path ---------------------------------------------

Deno.test("the three bridge tools are registered, grouped, and say what they need", () => {
  const names = ["denext_component_tree", "denext_why_render", "denext_hook_state"];
  assertEquals(TOOL_GROUPS.devtools, names);
  for (const name of names) {
    const tool = TOOLS.find((t) => t.name === name);
    assert(tool, `${name} is registered`);
    assertStringIncludes(tool!.description, "deno task dev");
    assertStringIncludes(tool!.description, "open in a browser");
    assertEquals(tool!.inputSchema.type, "object");
  }
  assertEquals(TOOLS.find((t) => t.name === "denext_why_render")!.inputSchema.required, [
    "component",
  ]);
});

Deno.test({
  name: "with no dev server running, the bridge reports exactly that",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    assertEquals(await fetchDevInspect(dir), { ok: false, reason: "no-dev-server" });
    const res = await runTool("denext_component_tree", { dir });
    assertEquals(res.isError, true);
    assertStringIncludes(res.content[0].text, "no dev server running (`deno task dev`)");
    const why = await runTool("denext_why_render", { dir, component: "Counter" });
    assertEquals(why.isError, true);
    assertStringIncludes(why.content[0].text, "no dev server running");
    const missing = await runTool("denext_hook_state", { dir });
    assertEquals(missing.isError, true);
    assertStringIncludes(missing.content[0].text, "Pass a `component` name.");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- the page-side sink ----------------------------------------------------------------

/** An inspector-API stub over a fixed tree, with a manual commit notifier. */
function fakeApi(tree: InspectNode[]): { api: DenextDevtoolsApi; commit: () => void } {
  const subs = new Set<() => void>();
  let reasonsOn = false;
  const api = asAny({
    getInspectorTree: () => tree,
    getRenderReason: (id: number) =>
      reasonsOn && id === 2 ? { props: ["label"], hooks: [], contexts: [], count: 2 } : null,
    enableRenderReasons: () => {
      reasonsOn = true;
    },
    disableRenderReasons: () => {
      reasonsOn = false;
    },
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  }) as DenextDevtoolsApi;
  return { api, commit: () => subs.forEach((fn) => fn()) };
}

/** A component node carrying one raw-bearing state cell, under a host wrapper. */
function inspectTree(count = 1): InspectNode[] {
  const kids: InspectNode[] = [];
  for (let i = 0; i < count; i++) {
    kids.push({
      id: 2 + i,
      name: `Counter${i}`,
      kind: "component",
      key: null,
      props: { preview: "{label}", type: "object", raw: null, size: 1 },
      hooks: [{
        index: 0,
        kind: "state",
        value: { preview: "7", type: "number", raw: 7 },
        editable: true,
        deps: [{ preview: '"x"', type: "string", raw: "x" }],
      }],
      contexts: [{ name: "Theme", value: { preview: '"dark"', type: "string", raw: "dark" } }],
      children: [],
    });
  }
  return [{
    id: 1,
    name: "div",
    kind: "host",
    key: null,
    props: { preview: "{}", type: "object" },
    hooks: [],
    contexts: [],
    children: kids,
  }];
}

Deno.test("buildSnapshot: hosts are spliced out, and every raw value is stripped", () => {
  const { api } = fakeApi(inspectTree());
  const snapshot = buildSnapshot(api);
  assertEquals(snapshot.truncated, false);
  assertEquals(snapshot.nodes.length, 1, "the host wrapper is not a component");
  const node = snapshot.nodes[0];
  assertEquals(node.name, "Counter0");
  const json = JSON.stringify(snapshot);
  assert(!json.includes('"raw"'), `no raw values survive: ${json.slice(0, 200)}`);
  assertEquals(node.props.preview, "{label}");
  assertEquals(node.hooks[0].value.preview, "7");
  assertEquals(node.hooks[0].deps?.[0].preview, '"x"');
  assertEquals(node.contexts[0].name, "Theme");
});

Deno.test("buildSnapshot: past the node cap the tree is cut and flagged truncated", () => {
  const { api } = fakeApi(inspectTree(2100));
  const snapshot = buildSnapshot(api);
  assertEquals(snapshot.truncated, true);
  assert(snapshot.nodes.length <= 2000, `capped at 2000, got ${snapshot.nodes.length}`);
  assert(JSON.stringify(snapshot).length <= 256 * 1024, "and inside the byte budget");
});

Deno.test({
  name: "installInspectSink: a burst of commits posts once, and pagehide flushes",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { api, commit } = fakeApi(inspectTree());
  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    assertEquals(url, DEV_INSPECT_PATH, "the sink posts to the dev server's own path");
    bodies.push(String(init?.body ?? ""));
    assertEquals(init?.method, "POST");
    assertEquals((init?.headers as Record<string, string>)["content-type"], "application/json");
    assertEquals(init?.keepalive, true);
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  const stop = installInspectSink(api);
  try {
    commit();
    commit();
    commit();
    assertEquals(bodies.length, 0, "the post is trailing-edge, not immediate");
    await new Promise((r) => setTimeout(r, 1700));
    assertEquals(bodies.length, 1, "three rapid commits coalesce into one post");
    const snapshot = JSON.parse(bodies[0]) as InspectSnapshot;
    assertEquals(snapshot.nodes[0].name, "Counter0");
    assertEquals(snapshot.nodes[0].reason?.count, 2, "the sink turns render reasons on itself");
    assert(!bodies[0].includes('"raw"'));

    globalThis.dispatchEvent(new Event("pagehide"));
    assertEquals(bodies.length, 2, "pagehide posts a final snapshot");
  } finally {
    stop();
    globalThis.fetch = realFetch;
  }
  commit();
  await new Promise((r) => setTimeout(r, 1700));
  assertEquals(bodies.length, 2, "the disposer unsubscribes");
});
