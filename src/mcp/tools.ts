// The denext MCP tool registry: the callable verbs the server exposes over `tools/call`.
//
// Each tool is `{ name, description, inputSchema, run }`. Every tool calls a denext function
// in-process (no subprocess, no re-exec of the CLI) — the same functions the CLI commands
// use, so behavior matches. `runTool` wraps a handler into the MCP `{ content, isError }`
// result shape.

import { generateArtifact, type GenerateKind } from "../build/generate.ts";
import { collectDoctorChecks } from "../cli/commands/doctor.ts";
import { runCodemod } from "../build/codemod.ts";
import { resolveProject } from "../build/paths.ts";
import { scanRoutes } from "../router/manifest.ts";
import type { DevEvent } from "../build/dev-events.ts";
import { fetchDevState } from "./dev-client.ts";
import { checkSnippet, type Diagnostic } from "./check.ts";
import { IMPORT_RULES, lookupImport } from "./next-denext-map.ts";

/** The MCP `tools/call` result: a list of content blocks plus an error flag. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** A registered MCP tool. */
export interface Tool {
  /** Tool name as the client calls it (snake_case, `denext_`-prefixed). */
  readonly name: string;
  /** One-line description shown in `tools/list`. */
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: Record<string, unknown>;
  /** Run the tool. Returns text (optionally flagged as an error). */
  run(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

/** Render `checkSnippet` diagnostics as human-readable lines. */
function formatDiagnostics(diags: Diagnostic[]): string {
  if (diags.length === 0) return "✓ No denext issues found. This looks like valid denext.";
  const icon = { error: "✗", warning: "⚠", info: "ℹ" };
  const lines = diags.map((d) => {
    const at = d.line > 0 ? ` (line ${d.line})` : "";
    return `${icon[d.severity]} ${d.severity} [${d.rule}]${at}: ${d.message}`;
  });
  const errors = diags.filter((d) => d.severity === "error").length;
  const header = errors > 0
    ? `${errors} denext error(s) — this is Next.js, not denext:`
    : "denext hints:";
  return `${header}\n${lines.join("\n")}`;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Format the doctor checks for a directory into a text report + error flag. */
async function doctorReport(dir: string): Promise<{ text: string; isError?: boolean }> {
  const checks = await collectDoctorChecks(dir);
  const lines = checks.map((c) => `${c.ok ? "✔" : "✖"} ${c.name}: ${c.detail}`);
  const failed = checks.some((c) => c.critical && !c.ok);
  const summary = failed ? "Problems found." : "All checks passed.";
  return { text: `denext doctor ▸ ${dir}\n${lines.join("\n")}\n\n${summary}`, isError: failed };
}

/** Format a dry-run codemod report (the Next→denext rewrites that would be applied). */
async function codemodReport(dir: string): Promise<{ text: string }> {
  const report = await runCodemod(dir, { write: false });
  if (report.files.length === 0) {
    return { text: `Scanned ${report.scanned} file(s). No Next.js→denext rewrites needed.` };
  }
  const blocks = report.files.map((f) => {
    const rewrites = f.rewrites.map((r) =>
      `    ${r.from} → ${r.to}${r.note ? ` (${r.note})` : ""}`
    );
    const warnings = f.warnings.map((w) => `    ⚠ ${w.specifier}: ${w.message}`);
    return `  ${f.path}\n${[...rewrites, ...warnings].join("\n")}`;
  });
  return {
    text: `Dry run — scanned ${report.scanned} file(s); ${report.files.length} would change ` +
      `(run \`denext codemod ${dir} --write\` to apply):\n${blocks.join("\n")}`,
  };
}

/** List an app's routes (pages + API) with their dynamic params. */
async function listRoutes(dir: string): Promise<string> {
  const paths = await resolveProject(dir);
  const m = await scanRoutes(paths.appDir);
  const fmt = (routePath: string, pattern: { kind: string; value: string }[]): string => {
    const params = pattern.filter((s) => s.kind !== "static").map((s) => s.value);
    return `  ${routePath}${params.length ? `   (params: ${params.join(", ")})` : ""}`;
  };
  const pages = m.pages.map((p) => fmt(p.routePath, p.pattern));
  const api = m.api.map((a) => fmt(a.routePath, a.pattern));
  if (pages.length === 0 && api.length === 0) return "No routes found (is this a denext app dir?).";
  return `Pages (${pages.length}):\n${pages.join("\n") || "  (none)"}\n\n` +
    `API routes (${api.length}):\n${api.join("\n") || "  (none)"}`;
}

/** Format one dev event as a single line. */
function formatEvent(e: DevEvent): string {
  const where = e.frame ? ` ${e.frame.display}:${e.frame.line}` : e.url ? ` (${e.url})` : "";
  const title = e.title ? `${e.title}: ` : "";
  return `[${e.kind}/${e.source}] ${e.level}: ${title}${e.message}${where}`;
}

/** Read the running dev server's recent events (server errors + browser console). */
async function devLogs(dir: string, kind?: string, limit?: number): Promise<string> {
  const state = await fetchDevState(dir, { kind, limit });
  if (!state) {
    return `No running dev server found for ${dir} (looked for .denext/dev.json). ` +
      "Start it with `deno task dev`, then reload the app in a browser to capture events.";
  }
  if (state.events.length === 0) {
    return `The dev server is running but has recorded no ${kind ?? ""} events yet.`.replace(
      "  ",
      " ",
    );
  }
  return `${state.events.length} recent dev event(s) (of ${state.total} retained):\n` +
    state.events.map(formatEvent).join("\n");
}

/** Every first-party denext MCP tool. */
export const TOOLS: readonly Tool[] = [
  {
    name: "denext_check_snippet",
    description:
      "Check a denext code snippet for Next.js→denext mistakes (wrong import source, misplaced " +
      '"use client", missing client boundary). Run this on code you are about to write.',
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "The .ts/.tsx source to check." } },
      required: ["code"],
    },
    run: (args) => {
      const diags = checkSnippet(str(args.code));
      const hasError = diags.some((d) => d.severity === "error");
      return Promise.resolve({ text: formatDiagnostics(diags), isError: hasError });
    },
  },
  {
    name: "denext_import_map",
    description:
      "Map a Next.js/React import specifier to its denext equivalent. Omit `specifier` to get " +
      "the whole table.",
    inputSchema: {
      type: "object",
      properties: {
        specifier: {
          type: "string",
          description: 'A Next.js/React specifier, e.g. "next/navigation" or "react".',
        },
      },
    },
    run: (args) => {
      const spec = str(args.specifier);
      if (spec) return Promise.resolve({ text: lookupImport(spec).message });
      const table = IMPORT_RULES.map((r) => `${r.from} → ${r.to}${r.note ? ` (${r.note})` : ""}`);
      return Promise.resolve({ text: `Next.js/React → denext:\n${table.join("\n")}` });
    },
  },
  {
    name: "denext_generate",
    description:
      "Scaffold a denext artifact into a project (writes files). kind = page|route|layout|" +
      "component|api|action|test|docker.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "page|route|layout|component|api|action|test|docker" },
        name: { type: "string", description: "Route/component/action name (optional for docker)." },
        dir: { type: "string", description: "Project directory (default: current directory)." },
      },
      required: ["kind"],
    },
    run: async (args) => {
      const { written, skipped } = await generateArtifact(
        str(args.dir, "."),
        str(args.kind) as GenerateKind,
        str(args.name),
      );
      const lines = [
        ...written.map((p) => `+ ${p}`),
        ...skipped.map((p) => `• exists, skipped: ${p}`),
      ];
      return { text: lines.length ? lines.join("\n") : "(nothing generated)" };
    },
  },
  {
    name: "denext_doctor",
    description:
      "Run denext's project health check (config, app dir, route conformance) on a directory.",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "Project directory (default: .)" } },
    },
    run: (args) => doctorReport(str(args.dir, ".")),
  },
  {
    name: "denext_codemod",
    description:
      "Report (dry-run, no writes) the Next.js→denext import rewrites a codemod would make in a " +
      "project directory.",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "Project directory (default: .)" } },
    },
    run: (args) => codemodReport(str(args.dir, ".")),
  },
  {
    name: "denext_list_routes",
    description:
      "List an app's routes (pages + API route handlers) with their dynamic params, by " +
      "scanning app/. Works without a running dev server.",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "Project directory (default: .)" } },
    },
    run: async (args) => ({ text: await listRoutes(str(args.dir, ".")) }),
  },
  {
    name: "denext_dev_logs",
    description:
      "Read the RUNNING dev server's recent events — server-side errors (with codeframes) and " +
      "the browser's console/errors. Use it to see what actually broke at runtime. Requires " +
      "`deno task dev` to be running.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Project directory (default: .)" },
        kind: { type: "string", description: 'Filter: "error" or "console" (default: both).' },
        limit: { type: "number", description: "Max events to return (default 50)." },
      },
    },
    run: async (args) => ({
      text: await devLogs(
        str(args.dir, "."),
        str(args.kind) || undefined,
        typeof args.limit === "number" ? args.limit : undefined,
      ),
    }),
  },
];

/**
 * Run a tool by name and wrap its output in the MCP `tools/call` result shape.
 *
 * @param name The tool name.
 * @param args The tool arguments (from `params.arguments`).
 * @returns The `{ content, isError }` result; an unknown tool or a thrown error is an
 *   `isError` result rather than a protocol error, per the MCP tool-call convention.
 */
export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  try {
    const { text, isError } = await tool.run(args ?? {});
    return { content: [{ type: "text", text }], isError };
  } catch (e) {
    return {
      content: [{ type: "text", text: `tool error: ${(e as Error).message}` }],
      isError: true,
    };
  }
}
