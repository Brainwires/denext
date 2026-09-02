// The denext MCP server + its snippet checker, import map, tools, and the llms.txt generator.
//
// The protocol is exercised through the pure `dispatch()` (no real stdio), the tools through
// `runTool()`, and the checker/import-map as pure functions — so this is fast and hermetic.
// One tool (`denext_generate`) is driven against a temp dir to prove the file-writing path.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checkSnippet } from "../src/mcp/check.ts";
import { IMPORT_RULES, lookupImport } from "../src/mcp/next-denext-map.ts";
import { dispatch } from "../src/mcp/server.ts";
import { runTool, TOOLS } from "../src/mcp/tools.ts";
import {
  browserLogEvent,
  captureConsole,
  type DevEvent,
  DevEventLog,
} from "../src/build/dev-events.ts";
import { fetchDevState, readDevInfo } from "../src/mcp/dev-client.ts";
import { llmsFull, llmsIndex } from "../scripts/gen-llms-txt.ts";

const HELLO = new URL("../examples/hello", import.meta.url).pathname;

// ── Snippet checker ───────────────────────────────────────────────────────────

Deno.test("checkSnippet: flags a React import as a denext error with the fix", () => {
  const diags = checkSnippet(`import { useState } from "react";`);
  assertEquals(diags.length, 1);
  assertEquals(diags[0].severity, "error");
  assertEquals(diags[0].rule, "import-source");
  assertStringIncludes(diags[0].message, 'from "denext"');
  assertEquals(diags[0].line, 1);
});

Deno.test("checkSnippet: maps next/* imports to the right denext module", () => {
  assertStringIncludes(
    checkSnippet(`import { cookies } from "next/headers";`)[0].message,
    "denext/server",
  );
  assertStringIncludes(
    checkSnippet(`import Link from "next/link";`)[0].message,
    "denext",
  );
});

Deno.test("checkSnippet: clean denext code produces no findings", () => {
  const ok = `"use client";\nimport { useState } from "denext";\n` +
    `export function C() { const [n, setN] = useState(0); return n; }`;
  assertEquals(checkSnippet(ok), []);
});

Deno.test("checkSnippet: a misplaced directive is a warning", () => {
  const code = `import { useState } from "denext";\n"use client";`;
  const warn = checkSnippet(code).find((d) => d.rule === "directive-placement");
  assert(warn, "expected a directive-placement warning");
  assertEquals(warn!.severity, "warning");
});

Deno.test("checkSnippet: interactive code without a client boundary gets an info hint", () => {
  const code = `import { useState } from "denext";\n` +
    `export function C() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }`;
  const hint = checkSnippet(code).find((d) => d.rule === "client-boundary");
  assert(hint, "expected a client-boundary hint");
  assertEquals(hint!.severity, "info");
});

// ── Import map ────────────────────────────────────────────────────────────────

Deno.test("lookupImport: resolves core and prefixed specifiers, and passes through denext", () => {
  assertEquals(lookupImport("react").rule?.to, "denext");
  assertEquals(lookupImport("next/navigation").rule?.to, "denext/server");
  // A deeper next/* path still matches its prefix rule.
  assertEquals(lookupImport("next/font/google").rule?.to, "denext");
  // Already-denext and unknown specifiers have no rule.
  assertEquals(lookupImport("denext/server").rule, null);
  assertEquals(lookupImport("zod").rule, null);
});

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

Deno.test("dispatch: initialize returns the protocol version + server info", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assertEquals(res?.result.protocolVersion, "2024-11-05");
  assertEquals(res?.result.serverInfo.name, "denext");
  assert(res?.result.capabilities.tools, "advertises tools capability");
});

Deno.test("dispatch: a notification produces no response", async () => {
  assertEquals(await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

Deno.test("dispatch: tools/list lists every registered tool with a schema", async () => {
  const res = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = res?.result.tools.map((t: { name: string }) => t.name);
  assertEquals(names.length, TOOLS.length);
  assert(names.includes("denext_check_snippet"));
  assert(names.includes("denext_import_map"));
  for (const t of res?.result.tools) assertEquals(t.inputSchema.type, "object");
});

Deno.test("dispatch: tools/call runs the checker and flags an error", async () => {
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "denext_check_snippet", arguments: { code: `import x from "react";` } },
  });
  assertEquals(res?.result.isError, true);
  assertStringIncludes(res?.result.content[0].text, "denext");
});

Deno.test("dispatch: resources/read serves the import-map resource; unknown method errors", async () => {
  const read = await dispatch({
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: "denext://import-map" },
  });
  assertStringIncludes(read?.result.contents[0].text, "Next.js → denext");

  const bad = await dispatch({ jsonrpc: "2.0", id: 5, method: "totally/unknown" });
  assertEquals(bad?.error?.code, -32601);
});

// ── Tools ─────────────────────────────────────────────────────────────────────

Deno.test("runTool: an unknown tool is an isError result, not a throw", async () => {
  const res = await runTool("nope", {});
  assertEquals(res.isError, true);
  assertStringIncludes(res.content[0].text, "unknown tool");
});

Deno.test("runTool: import_map with no specifier returns the whole table", async () => {
  const res = await runTool("denext_import_map", {});
  assertStringIncludes(res.content[0].text, "react → denext");
  assert(!res.isError);
});

Deno.test("runTool: generate scaffolds a component into a temp project", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-mcp-gen-" });
  try {
    const res = await runTool("denext_generate", { kind: "component", name: "UserCard", dir });
    assert(!res.isError, res.content[0].text);
    assertStringIncludes(res.content[0].text, "UserCard");
    // The scaffolded file actually exists on disk.
    const found = [...Deno.readDirSync(dir)].length > 0 ||
      await exists(`${dir}/components`);
    assert(found, "generate wrote something into the project dir");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTool: codemod dry-run reports Next→denext rewrites without writing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-mcp-codemod-" });
  try {
    const file = `${dir}/comp.tsx`;
    const before = `import { useState } from "react";\nexport const x = useState;`;
    await Deno.writeTextFile(file, before);
    const res = await runTool("denext_codemod", { dir });
    assertStringIncludes(res.content[0].text, "react → denext");
    // Dry run: the file on disk is untouched.
    assertEquals(await Deno.readTextFile(file), before);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTool: doctor reports a missing app directory as a failure", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-mcp-doctor-" });
  try {
    const res = await runTool("denext_doctor", { dir });
    assertEquals(res.isError, true);
    assertStringIncludes(res.content[0].text, "app directory");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ── llms.txt generator ────────────────────────────────────────────────────────

Deno.test("llmsIndex: is a valid llms.txt (H1 + blockquote + docs links)", () => {
  const txt = llmsIndex();
  assertStringIncludes(txt, "# denext");
  assertStringIncludes(txt, "> denext is Next.js's App Router");
  assertStringIncludes(txt, "https://denext.dev/llms-full.txt");
  assertStringIncludes(txt, "MCP server");
});

Deno.test("llmsFull: embeds the authoring guide and the API summary", async () => {
  const txt = await llmsFull();
  // From AGENTS.md:
  assertStringIncludes(txt, "The 6 rules that make code denext");
  // From the API reference summary (typed API client shipped this cycle):
  assertStringIncludes(txt, "createApiClient");
});

// ── Dev black box (ring buffer + browser log parsing) ─────────────────────────

Deno.test("DevEventLog: records, caps to its size, and filters snapshots", () => {
  const log = new DevEventLog(3);
  for (let i = 0; i < 5; i++) {
    log.record({ kind: "console", ts: i, source: "browser", level: "warn", message: `m${i}` });
  }
  log.record({ kind: "error", ts: 99, source: "server", level: "error", message: "boom" });
  // Cap is 3 → only the last three retained (m3, m4, then boom).
  assertEquals(log.size, 3);
  assertEquals(log.snapshot().map((e) => e.message), ["m3", "m4", "boom"]);
  // Filter by kind.
  assertEquals(log.snapshot({ kind: "error" }).length, 1);
  assertEquals(log.snapshot({ kind: "error" })[0].message, "boom");
});

Deno.test("captureConsole: records server console, passes through, and restores cleanly", () => {
  const events: DevEvent[] = [];
  const calls: string[] = [];
  const fake = {
    log: (...a: unknown[]) => calls.push("log:" + a.join(" ")),
    info: () => {},
    warn: (...a: unknown[]) => calls.push("warn:" + a.join(" ")),
    error: () => {},
    debug: () => {},
  };
  const restore = captureConsole(fake, (e) => events.push(e));
  fake.log("hello", 42);
  fake.warn("careful");
  // Recorded as server/console events…
  assertEquals(events.map((e) => e.kind), ["console", "console"]);
  assertEquals(events[0].source, "server");
  assertEquals(events[0].level, "log");
  assertStringIncludes(events[0].message, "hello");
  assertStringIncludes(events[0].message, "42");
  // …and still passed through to the original methods.
  assertEquals(calls, ["log:hello 42", "warn:careful"]);
  // Restore unwraps: further logs are no longer captured.
  restore();
  events.length = 0;
  fake.log("after");
  assertEquals(events.length, 0);
});

Deno.test("browserLogEvent: validates + clamps an untrusted payload, rejecting empties", () => {
  assertEquals(browserLogEvent(null), null);
  assertEquals(browserLogEvent({ level: "warn" }), null); // no message
  const e = browserLogEvent({ level: "error", message: "x", url: "/a", stack: "s" });
  assertEquals(e?.kind, "console");
  assertEquals(e?.source, "browser");
  assertEquals(e?.level, "error");
  // An unknown level normalizes to "log".
  assertEquals(browserLogEvent({ level: "debug", message: "y" })?.level, "log");
  // Over-long message is clamped.
  assert((browserLogEvent({ message: "z".repeat(5000) })?.message.length ?? 0) <= 2000);
});

// ── Dev-server discovery + live-log tool ──────────────────────────────────────

Deno.test("readDevInfo: null when no dev server is running", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-devinfo-" });
  try {
    assertEquals(await readDevInfo(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fetchDevState: reads .denext/dev.json and fetches the running server's events", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-devstate-" });
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const srv = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => resolve(port) },
    () => Response.json({ events: [{ kind: "error", message: "kaboom" }], total: 1 }),
  );
  const port = await promise;
  try {
    await Deno.mkdir(`${dir}/.denext`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.denext/dev.json`,
      JSON.stringify({ origin: `http://127.0.0.1:${port}`, port, hostname: "127.0.0.1" }),
    );
    const state = await fetchDevState(dir);
    assertEquals(state?.events[0].message, "kaboom");
    // The MCP tool renders it.
    const res = await runTool("denext_dev_logs", { dir });
    assertStringIncludes(res.content[0].text, "kaboom");
  } finally {
    ac.abort();
    await srv.finished;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTool: dev_logs guides the user when no dev server is running", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-nodev-" });
  try {
    const res = await runTool("denext_dev_logs", { dir });
    assertStringIncludes(res.content[0].text, "deno task dev");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTool: list_routes reports an app's pages and API routes with params", async () => {
  const res = await runTool("denext_list_routes", { dir: HELLO });
  assert(!res.isError, res.content[0].text);
  assertStringIncludes(res.content[0].text, "/blog/[slug]");
  assertStringIncludes(res.content[0].text, "slug");
  assertStringIncludes(res.content[0].text, "/api/hello");
});

// Keep IMPORT_RULES and AGENTS.md in sync: every rule's `from` should be documented.
Deno.test("IMPORT_RULES cover the core Next/React specifiers", () => {
  const froms = IMPORT_RULES.map((r) => r.from);
  for (const s of ["react", "react-dom", "next/navigation", "next/headers", "next/link"]) {
    assert(froms.includes(s), `missing import rule for ${s}`);
  }
});
