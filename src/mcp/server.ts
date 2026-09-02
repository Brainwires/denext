// The first-party denext MCP server — exposes denext's tooling to any MCP client (an
// agent, an IDE) so it can write, verify, and scaffold denext correctly.
//
// Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport). No SDK,
// no npm — MCP stdio is a handful of methods over JSON, so it's hand-rolled here to keep
// the framework's zero-runtime-npm promise. Launch it with `denext mcp`; a client is
// configured to run `deno run -A jsr:@denext/denext/cli mcp`.
//
// Tools (see `src/mcp/tools.ts`): `denext_check_snippet` (denext-correctness lint of a code
// string), `denext_import_map` (Next.js→denext import lookup), `denext_generate` (scaffold),
// `denext_doctor` (project health), `denext_codemod` (dry-run migration report). Resources
// expose the AI-authoring guide (AGENTS.md) and the import map so a client can ground itself.
//
// The protocol dispatch is a pure `dispatch(message)` → response so it is unit-testable
// without a real stdio pipe; `runStdioServer` is the thin I/O loop over it.

import { readPackageFile } from "./package-file.ts";
import { IMPORT_RULES } from "./next-denext-map.ts";
import { runTool, TOOLS } from "./tools.ts";

/** The MCP protocol revision this server implements. */
const PROTOCOL_VERSION = "2024-11-05";

/** A JSON-RPC 2.0 request or notification (a notification omits `id`). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  // deno-lint-ignore no-explicit-any
  params?: any;
}

/** A JSON-RPC 2.0 response. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  // deno-lint-ignore no-explicit-any
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** The MCP resources this server exposes (documentation an agent can ground on). */
export const RESOURCES = [
  {
    uri: "denext://guide",
    name: "denext authoring guide (for AI agents)",
    description: "AGENTS.md — the rules that make code denext, not Next, plus common tasks.",
    mimeType: "text/markdown",
  },
  {
    uri: "denext://import-map",
    name: "Next.js → denext import map",
    description: "How each Next.js/React import maps to its denext equivalent.",
    mimeType: "text/markdown",
  },
] as const;

/** Render the import map as a Markdown table (the `denext://import-map` resource body). */
function importMapMarkdown(): string {
  const rows = IMPORT_RULES.map((r) => {
    const note = r.note ? r.note.replace(/\|/g, "\\|") : "";
    return `| \`${r.from}\` | \`${r.to}\` | ${note} |`;
  });
  return `# Next.js → denext import map\n\n| Next.js / React | denext | Notes |\n| --- | --- | --- |\n${
    rows.join("\n")
  }\n`;
}

/** Read one resource's body by URI (throws for an unknown URI). */
async function readResource(uri: string): Promise<{ mimeType: string; text: string }> {
  if (uri === "denext://guide") {
    return { mimeType: "text/markdown", text: await readPackageFile("AGENTS.md") };
  }
  if (uri === "denext://import-map") {
    return { mimeType: "text/markdown", text: importMapMarkdown() };
  }
  throw new Error(`unknown resource: ${uri}`);
}

/** The server's own name/version (version read from the package deno.json). */
async function serverInfo(): Promise<{ name: string; version: string }> {
  let version = "0.0.0";
  try {
    version = JSON.parse(await readPackageFile("deno.json")).version ?? version;
  } catch {
    // best-effort — an unreadable/edge deno.json just leaves the placeholder version.
  }
  return { name: "denext", version };
}

/** A JSON-RPC error response. */
function rpcError(
  id: JsonRpcResponse["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The tool descriptors for `tools/list` (name/description/schema only). */
function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Handle one parsed JSON-RPC message and produce its response.
 *
 * @param msg The parsed request or notification.
 * @returns The response to write, or `null` for a notification (no reply).
 */
export async function dispatch(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  // Notifications (no id, or the initialized notice) get no response.
  if (msg.method.startsWith("notifications/")) return null;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: await serverInfo(),
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolList() } };
    case "tools/call": {
      const name = msg.params?.name as string;
      const result = await runTool(name, msg.params?.arguments ?? {});
      return { jsonrpc: "2.0", id, result };
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: RESOURCES } };
    case "resources/read": {
      const uri = msg.params?.uri as string;
      try {
        const { mimeType, text } = await readResource(uri);
        return { jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType, text }] } };
      } catch (e) {
        return rpcError(id, -32602, (e as Error).message);
      }
    }
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

/**
 * Run the MCP server over stdio: read newline-delimited JSON-RPC from stdin, dispatch each
 * message, and write responses to stdout. Returns when stdin closes.
 */
export async function runStdioServer(): Promise<void> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const write = (res: JsonRpcResponse) =>
    Deno.stdout.write(encoder.encode(JSON.stringify(res) + "\n"));

  // A single JSON-RPC message is small; cap the pending buffer so a client that streams a
  // huge payload with no newline can't grow it without bound (OOM guard).
  const MAX_LINE = 8 * 1024 * 1024;
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      await handleLine(line, write);
    }
    if (buf.length > MAX_LINE) {
      await write(rpcError(null, -32700, "message too large"));
      buf = "";
    }
  }
}

/** Parse one stdin line as JSON-RPC, dispatch it, and write any response. */
async function handleLine(
  line: string,
  write: (res: JsonRpcResponse) => unknown,
): Promise<void> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line);
  } catch {
    await write(rpcError(null, -32700, "parse error"));
    return;
  }
  try {
    const res = await dispatch(msg);
    if (res) await write(res);
  } catch (e) {
    await write(rpcError(msg.id ?? null, -32603, `internal error: ${(e as Error).message}`));
  }
}
