// The MCP server's wire protocol and stdio transport.
//
// `mcp.test.ts` covers the tools/checker/dev black box; this file covers the JSON-RPC layer
// itself: every `dispatch` method + error path, the resource bodies, and the newline-delimited
// stdio framing loop (multi-message chunks, split messages, blank lines, parse/internal errors,
// notifications, and the OOM guard) driven through injected in-memory streams — no real pipe.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  dispatch,
  type JsonRpcRequest,
  type JsonRpcResponse,
  RESOURCES,
  runStdioServer,
} from "../src/mcp/server.ts";
import { activeTools, resolveToolNames, TOOL_GROUPS, TOOLS } from "../src/mcp/tools.ts";

// ── dispatch: every method + error path ───────────────────────────────────────

Deno.test("dispatch: initialize advertises tools/resources/prompts + a real version", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const caps = res?.result.capabilities;
  assert(caps.tools && caps.resources && caps.prompts, "all three capabilities advertised");
  assertEquals(res?.result.serverInfo.name, "denext");
  // The version is read from the package deno.json — a real semver, not the 0.0.0 placeholder.
  assert(/^\d+\.\d+\.\d+/.test(res?.result.serverInfo.version), res?.result.serverInfo.version);
});

Deno.test("dispatch: ping returns an empty result", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 7, method: "ping" });
  assertEquals(res?.id, 7);
  assertEquals(res?.result, {});
  assert(!res?.error);
});

Deno.test("dispatch: resources/list enumerates the guide + import-map resources", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 8, method: "resources/list" });
  const uris = res?.result.resources.map((r: { uri: string }) => r.uri);
  assertEquals(uris, RESOURCES.map((r) => r.uri));
  assert(uris.includes("denext://guide"));
  assert(uris.includes("denext://import-map"));
});

Deno.test("dispatch: prompts/list is an empty list (declared, none yet)", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 9, method: "prompts/list" });
  assertEquals(res?.result.prompts, []);
});

Deno.test("dispatch: resources/read serves the AGENTS.md guide body", async () => {
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 10,
    method: "resources/read",
    params: { uri: "denext://guide" },
  });
  const doc = res?.result.contents[0];
  assertEquals(doc.uri, "denext://guide");
  assertEquals(doc.mimeType, "text/markdown");
  assertStringIncludes(doc.text, "The 6 rules that make code denext");
});

Deno.test("dispatch: resources/read of an unknown URI is an invalid-params error", async () => {
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 11,
    method: "resources/read",
    params: { uri: "denext://nope" },
  });
  assertEquals(res?.error?.code, -32602);
  assertStringIncludes(res?.error?.message ?? "", "unknown resource");
});

Deno.test("dispatch: tools/call of an unknown tool is an isError result, not an RPC error", async () => {
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "denext_not_a_tool", arguments: {} },
  });
  // A bad tool name is a tool-level failure (result.isError), never a JSON-RPC error frame.
  assert(!res?.error);
  assertEquals(res?.result.isError, true);
  assertStringIncludes(res?.result.content[0].text, "unknown tool");
});

Deno.test("dispatch: tools/call with omitted arguments defaults to an empty object", async () => {
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: { name: "denext_import_map" }, // no `arguments` → whole table
  });
  assert(!res?.result.isError);
  assertStringIncludes(res?.result.content[0].text, "react → denext");
});

Deno.test("dispatch: tools/list is complete, unique, and denext-prefixed", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 14, method: "tools/list" });
  const names: string[] = res?.result.tools.map((t: { name: string }) => t.name);
  assertEquals(names.length, TOOLS.length);
  assertEquals(new Set(names).size, names.length, "tool names are unique");
  for (const t of res?.result.tools) {
    assert(t.name.startsWith("denext_"), `tool ${t.name} should be denext_-prefixed`);
    assert(
      typeof t.description === "string" && t.description.length > 0,
      `${t.name} has a description`,
    );
    assertEquals(t.inputSchema.type, "object");
  }
});

Deno.test("dispatch: an id-less notification never gets a reply", async () => {
  assertEquals(await dispatch({ jsonrpc: "2.0", method: "notifications/cancelled" }), null);
});

Deno.test("dispatch: a null id is preserved on the response", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: null, method: "ping" });
  assertEquals(res?.id, null);
});

// ── tool groups + --disable resolution ────────────────────────────────────────

Deno.test("TOOL_GROUPS partitions every tool into exactly one group", () => {
  const grouped = Object.values(TOOL_GROUPS).flat();
  // No tool appears twice…
  assertEquals(new Set(grouped).size, grouped.length, "a tool is in two groups");
  // …and the groups cover exactly the registered tools.
  assertEquals(new Set(grouped), new Set(TOOLS.map((t) => t.name)));
});

Deno.test("resolveToolNames: a group name expands to its tools", () => {
  const { names, unknown } = resolveToolNames(["rag", "docs"]);
  assertEquals(unknown, []);
  assertEquals(names, new Set([...TOOL_GROUPS.rag, ...TOOL_GROUPS.docs]));
});

Deno.test("resolveToolNames: bare and prefixed tool names both resolve", () => {
  assertEquals(resolveToolNames(["render"]).names, new Set(["denext_render"]));
  assertEquals(resolveToolNames(["denext_doctor"]).names, new Set(["denext_doctor"]));
});

Deno.test("resolveToolNames: is case-insensitive and reports unknown tokens", () => {
  const { names, unknown } = resolveToolNames([" RAG ", "not_a_tool", ""]);
  assertEquals(names, new Set(TOOL_GROUPS.rag));
  assertEquals(unknown, ["not_a_tool"]); // blank tokens are skipped, not reported
});

Deno.test("activeTools: removes the disabled names; empty set keeps all", () => {
  assertEquals(activeTools(new Set()).length, TOOLS.length);
  const remaining = activeTools(new Set(TOOL_GROUPS.rag));
  assertEquals(remaining.length, TOOLS.length - TOOL_GROUPS.rag.length);
  assert(!remaining.some((t) => t.name === "denext_query_codebase"));
});

Deno.test("dispatch: a filtered tool set hides disabled tools from tools/list", async () => {
  const tools = activeTools(resolveToolNames(["rag", "docs"]).names);
  const res = await dispatch({ jsonrpc: "2.0", id: 20, method: "tools/list" }, tools);
  const names: string[] = res?.result.tools.map((t: { name: string }) => t.name);
  assertEquals(names.length, tools.length);
  assert(!names.includes("denext_query_codebase"), "rag tool is hidden");
  assert(!names.includes("denext_search_docs"), "docs tool is hidden");
  assert(names.includes("denext_check_snippet"), "an unaffected tool remains");
});

Deno.test("dispatch: calling a disabled tool is an isError result saying so", async () => {
  const tools = activeTools(resolveToolNames(["rag"]).names);
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: { name: "denext_query_codebase", arguments: { query: "x" } },
  }, tools);
  assert(!res?.error);
  assertEquals(res?.result.isError, true);
  assertStringIncludes(res?.result.content[0].text, "disabled");
  // A still-enabled tool works through the same filtered set.
  const ok = await dispatch({
    jsonrpc: "2.0",
    id: 22,
    method: "tools/call",
    params: { name: "denext_import_map", arguments: {} },
  }, tools);
  assert(!ok?.result.isError);
});

// ── stdio transport: framing + error handling through injected streams ─────────

/** A ReadableStream that yields each string in `chunks` as one UTF-8 byte chunk. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/** Run the stdio server over `chunks`, returning every response line parsed as JSON. */
async function runOver(
  chunks: string[],
  tools?: readonly typeof TOOLS[number][],
): Promise<JsonRpcResponse[]> {
  const out: JsonRpcResponse[] = [];
  const dec = new TextDecoder();
  await runStdioServer({
    input: streamOf(chunks),
    tools,
    output: (bytes) => {
      // Each write is exactly one `JSON + "\n"` line.
      for (const line of dec.decode(bytes).split("\n")) {
        if (line.trim()) out.push(JSON.parse(line));
      }
    },
  });
  return out;
}

const req = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest) + "\n";

Deno.test("runStdioServer: dispatches several newline-delimited messages in order", async () => {
  const out = await runOver([req(1, "ping"), req(2, "tools/list"), req(3, "ping")]);
  assertEquals(out.map((r) => r.id), [1, 2, 3]);
  assertEquals(out[0].result, {});
  assert(Array.isArray(out[1].result.tools));
});

Deno.test("runStdioServer: reassembles a message split across chunks", async () => {
  const whole = req(5, "ping");
  const mid = Math.floor(whole.length / 2);
  const out = await runOver([whole.slice(0, mid), whole.slice(mid)]);
  assertEquals(out.length, 1);
  assertEquals(out[0].id, 5);
});

Deno.test("runStdioServer: handles two messages arriving in one chunk", async () => {
  const out = await runOver([req(1, "ping") + req(2, "ping")]);
  assertEquals(out.map((r) => r.id), [1, 2]);
});

Deno.test("runStdioServer: skips blank lines between messages", async () => {
  const out = await runOver(["\n\n" + req(1, "ping") + "\n\n" + req(2, "ping") + "\n"]);
  assertEquals(out.map((r) => r.id), [1, 2]);
});

Deno.test("runStdioServer: a notification produces no output line", async () => {
  const out = await runOver([
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    req(1, "ping"),
  ]);
  // Only the ping replies; the notification is silent.
  assertEquals(out.length, 1);
  assertEquals(out[0].id, 1);
});

Deno.test("runStdioServer: malformed JSON is a -32700 parse error with a null id", async () => {
  const out = await runOver(["this is not json\n", req(2, "ping")]);
  assertEquals(out[0].error?.code, -32700);
  assertEquals(out[0].id, null);
  // The loop keeps going after a bad line.
  assertEquals(out[1].id, 2);
});

Deno.test("runStdioServer: a message with no method surfaces as an internal error keeping its id", async () => {
  // Valid JSON but not a valid request (dispatch reads msg.method) → caught as -32603.
  const out = await runOver([JSON.stringify({ jsonrpc: "2.0", id: 42 }) + "\n"]);
  assertEquals(out[0].error?.code, -32603);
  assertEquals(out[0].id, 42);
});

Deno.test("runStdioServer: an over-long line with no newline trips the OOM guard", async () => {
  // 9 MB of a single unterminated line exceeds the 8 MB MAX_LINE cap.
  const out = await runOver(["x".repeat(9 * 1024 * 1024)]);
  assertEquals(out.length, 1);
  assertEquals(out[0].error?.code, -32700);
  assertStringIncludes(out[0].error?.message ?? "", "too large");
});

Deno.test("runStdioServer: closing input with no data writes nothing and returns", async () => {
  assertEquals(await runOver([]), []);
});

Deno.test("runStdioServer: honors a narrowed tools option end-to-end", async () => {
  const tools = activeTools(resolveToolNames(["rag"]).names);
  const out = await runOver([
    req(1, "tools/list"),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "denext_query_codebase", arguments: { query: "x" } },
    }) + "\n",
  ], tools);
  const listed: string[] = out[0].result.tools.map((t: { name: string }) => t.name);
  assert(!listed.includes("denext_query_codebase"), "disabled tool absent from tools/list");
  assertEquals(out[1].result.isError, true);
  assertStringIncludes(out[1].result.content[0].text, "disabled");
});
