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
import { renderComponent, renderRoute, routeMap } from "./inspect.ts";
import { checkSnippet, type Diagnostic } from "./check.ts";
import { IMPORT_RULES, lookupImport } from "./next-denext-map.ts";
import { formatHits, searchDocs } from "./rag/search.ts";
import { ensureCodeIndex, indexStats } from "./rag/codebase.ts";
import {
  findDefinition,
  findReferences,
  formatCodeHits,
  formatDefs,
  formatRefs,
  queryCodebase,
} from "./rag/code-search.ts";

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
  const dur = e.durationMs != null ? ` ${e.durationMs}ms` : "";
  const where = e.frame
    ? ` ${e.frame.display}:${e.frame.line}`
    : (e.url && e.kind !== "request")
    ? ` (${e.url})`
    : "";
  const title = e.title ? `${e.title}: ` : "";
  return `[${e.kind}/${e.source}] ${e.level}: ${title}${e.message}${dur}${where}`;
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
      "Read the RUNNING dev server's recent events — server errors (with codeframes), server + " +
      "browser console, completed requests (method/path/status/ms), and HMR events. Use it to " +
      "see what actually happened at runtime. Requires `deno task dev` to be running.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Project directory (default: .)" },
        kind: {
          type: "string",
          description: 'Filter: "error", "console", "request", or "hmr" (default: all).',
        },
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
  {
    name: "denext_render",
    description:
      "Render a route (by `path`) or a component (by `component` + `props`) server-side — NO " +
      "browser — and return the HTML + status. Use it to SEE what your change actually produces " +
      "(or the error it throws). Runs against the project you launched the server in.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'A route path to render, e.g. "/blog/hello".' },
        component: {
          type: "string",
          description: "A component module path (relative to dir) to render instead of a route.",
        },
        props: { type: "object", description: "Props for the component (with `component`)." },
        dir: { type: "string", description: "Project directory (default: .)" },
      },
    },
    run: async (args) => {
      const dir = str(args.dir, ".");
      if (str(args.component)) {
        const props = (args.props && typeof args.props === "object")
          ? args.props as Record<string, unknown>
          : {};
        return { text: await renderComponent(dir, str(args.component), props) };
      }
      if (str(args.path)) return { text: await renderRoute(dir, str(args.path)) };
      return {
        text: "Pass either `path` (a route) or `component` (a module path).",
        isError: true,
      };
    },
  },
  {
    name: "denext_route_map",
    description:
      "Map everything that renders at a route path: the matched page + params, its layout and " +
      "template chains (each tagged server/client), its loading/error/not-found boundaries and " +
      "parallel slots, and any API route at the same path. Saves opening many files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'The route path to map, e.g. "/blog/hello".' },
        dir: { type: "string", description: "Project directory (default: .)" },
      },
      required: ["path"],
    },
    run: async (args) => ({ text: await routeMap(str(args.dir, "."), str(args.path)) }),
  },
  {
    name: "denext_search_docs",
    description:
      "Search the denext docs — the API reference + the authoring guide — by keyword and get " +
      "the top matching symbols/sections with links and snippets. Use it to find the right " +
      "denext API or rule before writing code, instead of guessing Next.js.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Keywords or a natural-language question, e.g. "read a session cookie".',
        },
        limit: { type: "number", description: "Max results (default 8)." },
      },
      required: ["query"],
    },
    run: (args) => {
      const query = str(args.query);
      if (!query) {
        return Promise.resolve({ text: "Pass a `query` string to search.", isError: true });
      }
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      return Promise.resolve({ text: formatHits(searchDocs(query, limit), query) });
    },
  },
  {
    name: "denext_index_codebase",
    description:
      "Build or refresh a searchable index of THIS project's own source code (honors the " +
      "project's .gitignore). Optional — the query/definition/reference tools index on demand — " +
      "but call it to warm the cache and see how many files were indexed.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Project directory (default: current directory)." },
      },
    },
    run: async (args) => ({ text: indexStats(await ensureCodeIndex(str(args.dir, "."))) }),
  },
  {
    name: "denext_query_codebase",
    description:
      "Search THIS project's source code for the parts relevant to a task or concept, by " +
      "keyword or natural-language question. Returns the top matching file locations with " +
      "snippets — use it to find where something lives before editing.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'What to look for, e.g. "where is auth handled".',
        },
        limit: { type: "number", description: "Max results (default 8)." },
        dir: { type: "string", description: "Project directory (default: current directory)." },
      },
      required: ["query"],
    },
    run: async (args) => {
      const query = str(args.query);
      if (!query) return { text: "Pass a `query` string to search.", isError: true };
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const hits = await queryCodebase(str(args.dir, "."), query, limit);
      return { text: formatCodeHits(hits, query) };
    },
  },
  {
    name: "denext_find_definition",
    description:
      "Find where a symbol (function, class, const, type, interface, enum) is declared in THIS " +
      "project. Returns the declaration site(s), exported ones first.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "The identifier to locate, e.g. `getSession`." },
        dir: { type: "string", description: "Project directory (default: current directory)." },
      },
      required: ["symbol"],
    },
    run: async (args) => {
      const symbol = str(args.symbol);
      if (!symbol) return { text: "Pass a `symbol` name to locate.", isError: true };
      return { text: formatDefs(await findDefinition(str(args.dir, "."), symbol), symbol) };
    },
  },
  {
    name: "denext_find_references",
    description:
      "Find usages (call sites and other references) of a symbol across THIS project's source. " +
      "Returns file locations with the matching line; results are capped.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "The identifier to find references to." },
        limit: { type: "number", description: "Max sites to list (default 50)." },
        dir: { type: "string", description: "Project directory (default: current directory)." },
      },
      required: ["symbol"],
    },
    run: async (args) => {
      const symbol = str(args.symbol);
      if (!symbol) return { text: "Pass a `symbol` name to search for.", isError: true };
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      return { text: formatRefs(await findReferences(str(args.dir, "."), symbol, limit), symbol) };
    },
  },
];

/**
 * Named tool groups, so an operator can disable a whole family at once (e.g.
 * `denext mcp --disable rag,docs`) to trim the client's context budget. Every tool belongs
 * to exactly one group; a `--disable` token may also name a single tool directly.
 */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  /** Write-denext-correctly helpers: snippet lint, import map, scaffolding. */
  authoring: ["denext_check_snippet", "denext_import_map", "denext_generate"],
  /** Project operations: health check, codemod dry-run, route listing. */
  project: ["denext_doctor", "denext_codemod", "denext_list_routes"],
  /** Browser-free render/inspection of what a route or component produces. */
  inspect: ["denext_render", "denext_route_map"],
  /** The running dev server's live event log. */
  dev: ["denext_dev_logs"],
  /** denext's own docs search (API reference + authoring guide). */
  docs: ["denext_search_docs"],
  /** Project-codebase search: index, query, find-definition, find-references. */
  rag: [
    "denext_index_codebase",
    "denext_query_codebase",
    "denext_find_definition",
    "denext_find_references",
  ],
};

/** Normalize a `--disable` token to a tool name (accepts a bare or `denext_`-prefixed name). */
function toolNameOf(token: string): string {
  return token.startsWith("denext_") ? token : `denext_${token}`;
}

/**
 * Resolve `--disable` tokens (group names and/or tool names, in any casing) into the set of
 * tool names to disable, reporting any token that matches neither a group nor a known tool.
 *
 * @param tokens Raw tokens (e.g. `["rag", "docs", "render"]`).
 * @returns The resolved `names` to disable and the `unknown` tokens (for a stderr warning).
 */
export function resolveToolNames(
  tokens: readonly string[],
): { names: Set<string>; unknown: string[] } {
  const names = new Set<string>();
  const unknown: string[] = [];
  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    const group = TOOL_GROUPS[token];
    if (group) {
      for (const n of group) names.add(n);
      continue;
    }
    const name = toolNameOf(token);
    if (TOOLS.some((t) => t.name === name)) names.add(name);
    else unknown.push(raw.trim());
  }
  return { names, unknown };
}

/** The tools that remain after removing every name in `disabled`. */
export function activeTools(disabled: ReadonlySet<string>): readonly Tool[] {
  return disabled.size === 0 ? TOOLS : TOOLS.filter((t) => !disabled.has(t.name));
}

/**
 * Run a tool by name and wrap its output in the MCP `tools/call` result shape.
 *
 * @param name The tool name.
 * @param args The tool arguments (from `params.arguments`).
 * @param tools The active tool set to resolve against (default: all tools). A name that
 *   exists but is absent from this set is reported as disabled rather than unknown.
 * @returns The `{ content, isError }` result; an unknown/disabled tool or a thrown error is an
 *   `isError` result rather than a protocol error, per the MCP tool-call convention.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  tools: readonly Tool[] = TOOLS,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const disabled = TOOLS.some((t) => t.name === name);
    const text = disabled ? `tool disabled: ${name}` : `unknown tool: ${name}`;
    return { content: [{ type: "text", text }], isError: true };
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
