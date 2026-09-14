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
  INSPECT_TTL_MS,
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
    "open the app in a browser, then CALL THIS AGAIN — the DevTools sink has posted nothing yet",
  );
  assertStringIncludes(noSnapshot, "it arms on the first call");
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

/** What a `fakeApi` recorded, so a test can assert what the sink did NOT do. */
interface ApiCalls {
  /** How many times the sink walked the fiber tree (zero until it is armed). */
  trees: number;
  /** Net render-reason holds taken (the sink takes exactly one, and releases it). */
  reasonHolds: number;
}

/** An inspector-API stub over a fixed tree, with a manual commit notifier. */
function fakeApi(
  tree: InspectNode[],
): { api: DenextDevtoolsApi; commit: () => void; calls: ApiCalls } {
  const subs = new Set<() => void>();
  const calls: ApiCalls = { trees: 0, reasonHolds: 0 };
  let reasonsOn = false;
  const api = asAny({
    getInspectorTree: () => {
      calls.trees++;
      return tree;
    },
    getRenderReason: (id: number) =>
      reasonsOn && id === 2 ? { props: ["label"], hooks: [], contexts: [], count: 2 } : null,
    enableRenderReasons: () => {
      calls.reasonHolds++;
      reasonsOn = true;
    },
    disableRenderReasons: () => {
      calls.reasonHolds--;
      reasonsOn = false;
    },
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  }) as DenextDevtoolsApi;
  return { api, commit: () => subs.forEach((fn) => fn()), calls };
}

/** One POST the sink made. */
interface SentPost {
  body: string;
  keepalive: boolean;
}

/** A `globalThis.fetch` stand-in: answers the arming probe, records every POST. */
function stubFetch(armed: boolean): {
  posts: SentPost[];
  probes: number;
  restore: () => void;
} {
  const posts: SentPost[] = [];
  const state = { probes: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`${DEV_INSPECT_PATH}?probe`)) {
      state.probes++;
      return Promise.resolve(Response.json({ armed }));
    }
    assertEquals(url, DEV_INSPECT_PATH, "the sink posts to the dev server's own path");
    assertEquals(init?.method, "POST");
    assertEquals((init?.headers as Record<string, string>)["content-type"], "application/json");
    posts.push({ body: String(init?.body ?? ""), keepalive: init?.keepalive === true });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  return {
    posts,
    get probes() {
      return state.probes;
    },
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** UTF-8 byte length — every cap on this path counts bytes, not code units. */
function bytesOf(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** A component node carrying a number cell, a SECRET string cell, and a string context. */
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
      }, {
        index: 1,
        kind: "state",
        value: { preview: '"hunter2"', type: "string", raw: "hunter2" },
        editable: true,
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
  assertEquals(node.contexts[0].name, "Theme");
});

Deno.test("buildSnapshot: string CONTENTS are redacted to a length, everywhere", () => {
  const { api } = fakeApi(inspectTree());
  const snapshot = buildSnapshot(api);
  const json = JSON.stringify(snapshot);
  // The whole point (PROD-11): a `useState(password)` on a dev page must not leave it.
  assert(!json.includes("hunter2"), `the state string never leaves the page: ${json}`);
  assert(!json.includes("dark"), "nor a context string");
  assert(!json.includes('"x"'), "nor a dep string");

  const node = snapshot.nodes[0];
  assertEquals(node.hooks[1].value, { preview: "string(7)", type: "string", length: 7 });
  assertEquals(node.hooks[0].deps?.[0], { preview: "string(1)", type: "string", length: 1 });
  assertEquals(node.contexts[0].value, { preview: "string(4)", type: "string", length: 4 });
  // Numbers, booleans and shapes are NOT redacted — they are the useful, non-secret cases.
  assertEquals(node.hooks[0].value, { preview: "7", type: "number" });
  assertEquals(node.props, { preview: "{label}", type: "object", size: 1 });
});

Deno.test("buildSnapshot: past the node cap the tree is cut and flagged truncated", () => {
  const { api } = fakeApi(inspectTree(2100));
  const snapshot = buildSnapshot(api);
  assertEquals(snapshot.truncated, true);
  assert(snapshot.nodes.length <= 2000, `capped at 2000, got ${snapshot.nodes.length}`);
  assert(bytesOf(JSON.stringify(snapshot)) <= 256 * 1024, "and inside the byte budget");
});

Deno.test("buildSnapshot: the byte budget counts UTF-8 bytes, not code units", () => {
  // Every preview is 3-byte CJK: counting `.length` would let the body run ~3× over the
  // dev server's 256 KB ceiling and be refused with a 413 the page cannot see.
  const tree = inspectTree(1200);
  for (const kid of tree[0].children) kid.props = { preview: "名前".repeat(60), type: "object" };
  const { api } = fakeApi(tree);
  const snapshot = buildSnapshot(api);
  assertEquals(snapshot.truncated, true);
  assert(
    bytesOf(JSON.stringify(snapshot)) <= 256 * 1024,
    `bytes, not code units: ${bytesOf(JSON.stringify(snapshot))}`,
  );
});

Deno.test({
  name: "installInspectSink: unarmed, a commit walks NOTHING and re-probes at most every 10s",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { api, commit, calls } = fakeApi(inspectTree(3));
  const net = stubFetch(false); // the dev server says nobody is reading
  const stop = installInspectSink(api);
  try {
    await new Promise((r) => setTimeout(r, 20)); // let the install probe settle
    commit();
    commit();
    commit();
    await new Promise((r) => setTimeout(r, 1700));
    assertEquals(net.posts.length, 0, "nothing is posted while nobody is reading");
    assertEquals(calls.trees, 0, "and the fiber tree is never walked (PROD-12)");
    assertEquals(calls.reasonHolds, 0, "nor is render-reason tracking switched on");
    assertEquals(net.probes, 1, "three commits inside the 10 s window re-probe zero times");
  } finally {
    stop();
    net.restore();
  }
});

Deno.test({
  name: "installInspectSink: armed, it posts at once, then coalesces a burst of commits",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { api, commit, calls } = fakeApi(inspectTree());
  const net = stubFetch(true); // an MCP read has happened
  const stop = installInspectSink(api);
  try {
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(net.posts.length, 1, "arming posts immediately — the reader is waiting");
    assertEquals(calls.reasonHolds, 1, "and takes exactly ONE render-reason hold");

    commit();
    commit();
    commit();
    assertEquals(net.posts.length, 1, "the post is trailing-edge, not immediate");
    await new Promise((r) => setTimeout(r, 1700));
    assertEquals(net.posts.length, 2, "three rapid commits coalesce into one post");
    const snapshot = JSON.parse(net.posts[1].body) as InspectSnapshot;
    assertEquals(snapshot.nodes[0].name, "Counter0");
    assertEquals(snapshot.nodes[0].reason?.count, 2, "the sink turns render reasons on itself");
    assert(!net.posts[1].body.includes('"raw"'));

    globalThis.dispatchEvent(new Event("pagehide"));
    assertEquals(net.posts.length, 3, "pagehide posts a final snapshot");
    assertEquals(net.posts[2].keepalive, true, "which must outlive the page");
  } finally {
    stop();
    net.restore();
  }
  assertEquals(calls.reasonHolds, 0, "the disposer releases the sink's hold");
  commit();
  await new Promise((r) => setTimeout(r, 1700));
  assertEquals(net.posts.length, 3, "the disposer unsubscribes");
});

Deno.test({
  name: "installInspectSink: a >64 KiB snapshot is posted WITHOUT keepalive (PROD-7)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // A browser rejects a keepalive fetch whose body exceeds 64 KiB, and rejects it
  // unobservably — so with `keepalive: true` on the throttled post, EVERY page with more
  // than ~115 components silently delivered nothing at all.
  const { api, commit } = fakeApi(inspectTree(300));
  const net = stubFetch(true);
  const stop = installInspectSink(api);
  try {
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(net.posts.length, 1);
    const size = bytesOf(net.posts[0].body);
    assert(size > 64 * 1024, `the fixture must exceed the keepalive ceiling (${size} bytes)`);
    assert(size < 256 * 1024, `and stay under the server's cap (${size} bytes)`);
    assertEquals(net.posts[0].keepalive, false, "so the throttled post is NOT keepalive");

    commit();
    await new Promise((r) => setTimeout(r, 1700));
    assertEquals(net.posts[1].keepalive, false);

    // The pagehide flush has no such escape: over the ceiling it is skipped, and the last
    // throttled post stands, rather than being dropped in flight.
    globalThis.dispatchEvent(new Event("pagehide"));
    assertEquals(net.posts.length, 2, "an oversized final flush is skipped, not attempted");
  } finally {
    stop();
    net.restore();
  }
});

// ---- server: arming, scoping, TTL and forged bodies -------------------------------------

/** GET the read side with a `Referer`, i.e. as a PAGE rather than as the MCP bridge. */
function readAsPage(
  handle: (req: Request) => Promise<Response>,
  referer: string,
  query = "",
): Promise<Response> {
  return handle(
    new Request(`http://localhost${DEV_INSPECT_PATH}${query}`, {
      headers: { "sec-fetch-site": "same-origin", referer },
    }),
  );
}

Deno.test({
  name: "dev-inspect: `?probe=1` answers { armed }, and the first real read arms it",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle, st } = await devHandler(dir);
    assertEquals(st.devInspectArmed, false, "a fresh dev server is idle");
    const before = await readSnapshot(handle, "?probe=1");
    assertEquals(before.status, 200);
    assertEquals(await before.json(), { armed: false });
    assertEquals(st.devInspectArmed, false, "a probe is not a read — it never arms");

    // A real read arms, even when it finds nothing: that is exactly the first
    // `denext_component_tree` call, which tells every page to start snapshotting.
    assertEquals((await readSnapshot(handle)).status, 404);
    assertEquals(st.devInspectArmed, true);
    assertEquals(await (await readSnapshot(handle, "?probe=1")).json(), { armed: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev-inspect: DENEXT_DEV_INSPECT=1 arms the dev server from the start", async () => {
  const dir = await tempApp();
  const prev = Deno.env.get("DENEXT_DEV_INSPECT");
  try {
    Deno.env.set("DENEXT_DEV_INSPECT", "1");
    const st = createDevState({ paths: await resolveProject(dir), unbundled: false });
    assertEquals(st.devInspectArmed, true);
    Deno.env.set("DENEXT_DEV_INSPECT", "0");
    assertEquals(
      createDevState({ paths: await resolveProject(dir), unbundled: false }).devInspectArmed,
      false,
      "only `1` arms it",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("DENEXT_DEV_INSPECT");
    else Deno.env.set("DENEXT_DEV_INSPECT", prev);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-inspect: a read FROM A PAGE sees only that page's own snapshot",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle } = await devHandler(dir);
    await postSnapshot(handle, fixtureSnapshot("/login"));
    await postSnapshot(handle, fixtureSnapshot("/blog/untrusted"));

    // The attack this closes: a script on /blog/<untrusted> reading /login's hook state.
    const own = await readAsPage(handle, "http://localhost/blog/untrusted");
    assertEquals(own.status, 200);
    assertEquals((await own.json()).snapshot.url, "/blog/untrusted");

    const other = await readAsPage(handle, "http://localhost/nothing-here");
    assertEquals(other.status, 404, "a page with no snapshot of its own gets nothing");
    await other.body?.cancel();

    const garbage = await readAsPage(handle, "not a url");
    assertEquals(garbage.status, 404, "an unparseable Referer selects nothing");
    await garbage.body?.cancel();

    // An explicit `?url=` still selects (the MCP bridge always passes one), and a caller
    // with no Referer at all is an out-of-process reader and gets the newest.
    assertEquals(
      (await (await readAsPage(handle, "http://localhost/blog/untrusted", "?url=/login")).json())
        .snapshot.url,
      "/login",
    );
    assertEquals(
      (await (await readSnapshot(handle)).json()).snapshot.url,
      "/blog/untrusted",
      "no Referer = the MCP bridge = the most recent page",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-inspect: a snapshot past the TTL is gone (and evicted)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle, st } = await devHandler(dir);
    await postSnapshot(handle, fixtureSnapshot("/stale"));
    assertEquals(st.devInspect.size, 1);
    const entry = st.devInspect.get("/stale")!;
    entry.receivedAt -= INSPECT_TTL_MS + 1000;

    assertEquals((await readSnapshot(handle, "?url=/stale")).status, 404);
    assertEquals(st.devInspect.size, 0, "and the expired entry is dropped, not just hidden");
    assertEquals((await readSnapshot(handle)).status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "dev-inspect: the content-type guard is an EXACT media-type match",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle, st } = await devHandler(dir);
    // A substring test would have accepted this: the media type is text/html.
    const smuggled = await postSnapshot(handle, fixtureSnapshot("/smuggled"), {
      "content-type": "text/html; profile=application/json",
    });
    assertEquals(smuggled.status, 415);
    assertEquals(st.devInspect.size, 0);

    // Parameters on the real media type are fine (`application/json; charset=utf-8`).
    const ok = await postSnapshot(handle, fixtureSnapshot("/ok"), {
      "content-type": "Application/JSON; charset=utf-8",
    });
    assertEquals(ok.status, 204);
    assertEquals(st.devInspect.size, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A snapshot-shaped body whose every optional field is forged (SEC-5/SEC-6). */
function forgedBody(): string {
  return JSON.stringify({
    url: "/forged",
    at: "not a number",
    truncated: "yes",
    nodes: [{
      id: 1,
      name: "N".repeat(60_000),
      key: "k".repeat(5_000),
      badges: [{ evil: true }, "b".repeat(100), 42, null],
      props: { preview: "p".repeat(5_000), type: "sneaky", size: "big" },
      hooks: [null, { index: "one", kind: 7, value: 5, deps: "nope", name: {} }],
      contexts: [7, { name: null, value: null }],
      source: { file: 123, line: "x" },
      hooksNamed: "yes",
      reason: { props: [{}, "label"], hooks: ["zero", 1], contexts: null, count: "many" },
      children: [],
    }],
  });
}

Deno.test({
  name: "dev-inspect: a forged snapshot is stored as CLAMPED, rebuilt fields",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const dir = await tempApp();
  try {
    const { handle } = await devHandler(dir);
    assertEquals((await postSnapshot(handle, forgedBody())).status, 204);
    const body = await (await readSnapshot(handle, "?url=/forged")).json();
    const node = body.snapshot.nodes[0];

    assertEquals(node.name.length, 200, "a 60 000-character name is cut to 200");
    assertEquals(node.key.length, 200);
    assertEquals(node.badges, ["b".repeat(40)], "non-strings dropped, the rest cut to 40");
    assertEquals(node.props.type, "object", "an unknown value type becomes `object`");
    assertEquals(node.props.preview.length, 512);
    assertEquals(node.props.size, undefined, "a non-numeric size is dropped");
    assertEquals(node.source, undefined, "a source with no string `file` is dropped entirely");
    assertEquals(node.hooksNamed, undefined, "a non-boolean hooksNamed is dropped");
    assertEquals(node.reason, {
      props: ["label"],
      hooks: [1],
      contexts: [],
      count: 0,
    });
    assertEquals(node.hooks.length, 2);
    assertEquals(node.hooks[0], {
      index: 0,
      kind: "hook",
      value: { preview: "", type: "object" },
      editable: false,
    });
    assertEquals(node.hooks[1].index, 1, "a non-numeric index falls back to the position");
    assertEquals(node.hooks[1].kind, "hook");
    assertEquals(node.hooks[1].deps, undefined, "a non-array deps is dropped");
    assertEquals(node.hooks[1].name, undefined);
    assertEquals(node.contexts[0], { name: "Context", value: { preview: "", type: "object" } });
    assertEquals(body.snapshot.truncated, false, "a non-boolean `truncated` is false");
    assert(typeof body.snapshot.at === "number", "a non-numeric `at` becomes the server clock");

    // And the three formatters render it without throwing (they are what an agent reads).
    const inspect = { snapshot: body.snapshot, ageMs: 10 };
    assertStringIncludes(componentTreeText(inspect), `[${"b".repeat(40)}]`);
    assertStringIncludes(whyRenderText(inspect, node.name), "props changed: label");
    assertStringIncludes(hookStateText(inspect, node.name), "[0] hook = ");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the MCP formatters never throw on a snapshot of the wrong shape", () => {
  // Defense in depth: the dev server rebuilds every stored node, but these formatters run
  // on browser-supplied data and their output goes straight into an agent's context.
  const junk = asAny({
    url: 42,
    at: "x",
    truncated: 0,
    nodes: [{
      id: "one",
      name: null,
      key: 7,
      badges: "memo",
      props: null,
      hooks: "none",
      contexts: null,
      source: { file: 5, line: "x" },
      reason: { props: null, hooks: "0", contexts: 3, count: "9" },
      children: "kids",
    }, {
      id: 2,
      name: "Real",
      key: null,
      props: { preview: "{}", type: "object" },
      hooks: [null, { index: null, value: null, deps: 7 }],
      contexts: [],
      children: [],
    }],
  }) as InspectSnapshot;
  const inspect = { snapshot: junk, ageMs: 10 };
  assertStringIncludes(componentTreeText(inspect), "Real");
  assertStringIncludes(whyRenderText(inspect, "Real"), "no render reason recorded");
  assertStringIncludes(hookStateText(inspect, "Real"), "[0] hook = ");
  assertStringIncludes(hookStateText(inspect, "Real", 9), "no hook at index 9 (it has 2)");
  // The nameless forged node is still listed (as ""), and nothing threw getting here.
  assertStringIncludes(componentTreeText(inspect, { filter: "nope" }), "Components present:");
});
