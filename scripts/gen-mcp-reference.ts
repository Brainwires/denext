// Generate the in-site MCP reference from the live tool registry.
// Reads the SAME `TOOLS` / `RESOURCES` the `denext mcp` server serves, so the docs page
// (site /docs/mcp) can never drift from the tools the server actually exposes.
//
//   deno task docs:mcp      # regenerate mcp.json
//   deno task docs:build    # regenerate + export the site

import { TOOLS } from "../src/mcp/tools.ts";
import { RESOURCES } from "../src/mcp/server.ts";
import { dirname, fromFileUrl } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
/** Where the generated reference is committed (the docs page imports it). */
export const MCP_OUT = `${ROOT}site/app/docs/mcp/mcp.json`;

interface Param {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

type PropSchema = { type?: string; description?: string };

function paramOf(name: string, p: PropSchema, required: Set<string>): Param {
  return {
    name,
    type: p.type ?? "any",
    description: p.description ?? "",
    required: required.has(name),
  };
}

function paramsOf(schema: Record<string, unknown>): Param[] {
  const props = (schema.properties ?? {}) as Record<string, PropSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(props).map(([name, p]) => paramOf(name, p, required));
}

/** The reference as committed: every tool (with its parameters) and resource, as JSON text. */
export function generateMcpReference(): string {
  const tools = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    params: paramsOf(t.inputSchema),
  }));
  const resources = RESOURCES.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
  }));
  return JSON.stringify({ tools, resources }, null, 2) + "\n";
}

if (import.meta.main) {
  await Deno.mkdir(dirname(MCP_OUT), { recursive: true });
  await Deno.writeTextFile(MCP_OUT, generateMcpReference());
  console.log(`mcp reference: ${TOOLS.length} tools + ${RESOURCES.length} resources → ${MCP_OUT}`);
}
