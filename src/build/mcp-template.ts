// Project-level installation of denext's MCP server — the files and the `deno task` that
// `denext create --mcp` writes and `denext mcp init` adds to an existing project, so every
// coding agent opened in the project finds `denext mcp` without a global install.
//
// Version pinning: no client config names a denext version. Each one runs `deno task mcp`,
// and the `mcp` task in `deno.json` runs the CLI at the SAME specifier the project pins in its
// import map (`jsr:@denext/denext@^X/cli`, resolved through the project's `deno.lock`), so the
// server always matches the framework the app builds with, and upgrading denext in `deno.json`
// moves the server with it. `deno` is a real executable on every OS (no `cmd /c` shim on
// Windows), and `deno task` finds `deno.json` by walking up from the working directory and
// always runs the task in that file's directory.
//
// Build-time only; never imported by a shipped bundle.

import { join } from "@std/path";
import { readJson, setJsonValue } from "./json-edit.ts";

/** The MCP clients a project-level config can be written for. */
export const MCP_CLIENTS = ["claude", "vscode", "cursor", "gemini", "codex"] as const;
/** One of {@linkcode MCP_CLIENTS}. */
export type McpClient = (typeof MCP_CLIENTS)[number];

/** The clients written when none are named: the three with stable project-level files. */
export const DEFAULT_MCP_CLIENTS: readonly McpClient[] = ["claude", "vscode", "cursor"];

/** The server name every client config registers denext under. */
const MCP_SERVER_NAME = "denext";

/** The `deno task` the client configs run. */
const MCP_TASK = "mcp";

/** Where each client reads its project-level config, for help text and docs. */
export const MCP_CLIENT_FILES: Readonly<Record<McpClient, string>> = {
  claude: ".mcp.json",
  vscode: ".vscode/mcp.json",
  cursor: ".cursor/mcp.json",
  gemini: ".gemini/settings.json",
  codex: ".codex/config.toml",
};

/**
 * The `mcp` task's command: the project's pinned denext CLI running `denext mcp`.
 *
 * @param cli The pinned CLI specifier (`jsr:@denext/denext@^X/cli`).
 * @param disable Tool groups / names to hide (`denext mcp --disable`), comma-separated.
 * @returns The task command.
 */
export function mcpTaskCommand(cli: string, disable?: string): string {
  const groups = (disable ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return `deno run -A ${cli} mcp` + (groups.length ? ` --disable ${groups.join(",")}` : "");
}

/** A client's stdio server entry: JSON clients get an object under their root key. */
interface JsonClientConfig {
  /** The key the servers map lives under (`mcpServers` / `servers`). */
  readonly rootKey: string;
  /** The `denext` server entry. */
  readonly entry: Record<string, unknown>;
}

/**
 * The server entry for a JSON-configured client. Every one runs `deno task mcp`:
 *
 * - Claude Code starts a project server in the project directory (`.mcp.json`'s own dir).
 * - VS Code's `cwd` defaults to the workspace folder.
 * - Cursor does not document the server's working directory, so its entry names the config
 *   with `${workspaceFolder}` (which Cursor resolves to the folder holding `.cursor/`).
 * - Gemini CLI starts servers from the directory it runs in (the project).
 *
 * @param client A JSON client.
 * @param denoConfig The project's Deno config file name (`deno.json` / `deno.jsonc`).
 * @returns Its root key and entry.
 */
function jsonClientConfig(
  client: Exclude<McpClient, "codex">,
  denoConfig: string,
): JsonClientConfig {
  const args = ["task", MCP_TASK];
  switch (client) {
    case "claude":
      return { rootKey: "mcpServers", entry: { type: "stdio", command: "deno", args } };
    case "vscode":
      return { rootKey: "servers", entry: { type: "stdio", command: "deno", args } };
    case "cursor":
      return {
        rootKey: "mcpServers",
        entry: {
          type: "stdio",
          command: "deno",
          args: ["task", "--config", "${workspaceFolder}/" + denoConfig, MCP_TASK],
        },
      };
    case "gemini":
      return { rootKey: "mcpServers", entry: { command: "deno", args } };
  }
}

/** The Codex table (`.codex/config.toml`); Codex loads it only for a trusted project. */
const CODEX_TABLE = `[mcp_servers.${MCP_SERVER_NAME}]
# denext's MCP server, at the version this project pins (\`deno task ${MCP_TASK}\` in deno.json).
command = "deno"
args = ["task", "${MCP_TASK}"]
`;

/** The header line that opens the Codex table. */
const CODEX_HEADER = `[mcp_servers.${MCP_SERVER_NAME}]`;

/**
 * The full text of a fresh config file for `client` (no existing file to merge into).
 *
 * @param client The client.
 * @param denoConfig The project's Deno config file name.
 * @returns The file's contents.
 */
export function mcpClientFile(client: McpClient, denoConfig = "deno.json"): string {
  if (client === "codex") return CODEX_TABLE;
  const { rootKey, entry } = jsonClientConfig(client, denoConfig);
  return JSON.stringify({ [rootKey]: { [MCP_SERVER_NAME]: entry } }, null, 2) + "\n";
}

/** The README task row `--mcp` adds. */
export const MCP_README_ROWS =
  "| `deno task mcp` | denext's MCP server for coding agents (`.mcp.json`, `.vscode/`, `.cursor/` run it) |\n";

/** The `AGENTS.md` section a scaffold with both `--fallow` and `--mcp` appends. */
export const MCP_AGENTS_SECTION = `
## denext MCP server

This project registers denext's MCP server (\`deno task mcp\`, the denext version \`deno.json\`
pins) in \`.mcp.json\`, \`.vscode/mcp.json\` and \`.cursor/mcp.json\`. Prefer its tools over
guessing from Next.js:

| When the agent is about to...                    | Call                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| write a component, page or route                 | \`denext_check_snippet\` (lints the code for Next-isms)  |
| import from \`react\` / \`next/*\`                   | \`denext_import_map\`                                    |
| answer a denext question                         | \`denext_search_docs\`, then \`denext_read_docs\`          |
| add a page, component, route or test             | \`denext_generate\`                                      |
| see what a route renders, or why it fails        | \`denext_render\`, \`denext_route_map\`                    |
| debug the running dev server                     | \`denext_dev_logs\`                                      |
| check the toolchain                              | \`denext_doctor\`                                        |
`;

/** Options for {@linkcode addMcp} / {@linkcode writeMcpClientConfigs}. */
export interface AddMcpOptions {
  /** The clients to configure (default {@linkcode DEFAULT_MCP_CLIENTS}). */
  readonly clients?: readonly McpClient[];
  /** Tool groups / names baked into the `mcp` task's `--disable`. */
  readonly disable?: string;
  /** Report the plan without writing anything. */
  readonly dryRun?: boolean;
  /** Replace an existing `denext` entry (and the `mcp` task) instead of keeping it. */
  readonly force?: boolean;
}

/** What {@linkcode addMcp} did (or, on a dry run, would do). */
export interface AddMcpResult {
  /** Paths written (relative to the project). */
  readonly written: string[];
  /** Paths left alone because they already register denext (or the task exists). */
  readonly skipped: string[];
  /** Paths that could not be edited, with the reason (`path: reason`). */
  readonly errors: string[];
}

/** Other spellings `--clients` accepts. */
const CLIENT_ALIASES: Readonly<Record<string, McpClient>> = {
  "claude-code": "claude",
  "code": "vscode",
  "vs-code": "vscode",
  "gemini-cli": "gemini",
};

/**
 * Parse a `--clients` list (`claude,vscode`, `all`).
 *
 * @param spec The comma-separated list; empty means the defaults.
 * @returns The clients, plus any unknown names.
 */
export function parseMcpClients(spec: string | undefined): {
  clients: McpClient[];
  unknown: string[];
} {
  const names = (spec ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return { clients: [...DEFAULT_MCP_CLIENTS], unknown: [] };
  if (names.includes("all")) return { clients: [...MCP_CLIENTS], unknown: [] };
  const clients: McpClient[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const c = CLIENT_ALIASES[n] ?? n;
    if ((MCP_CLIENTS as readonly string[]).includes(c)) {
      if (!clients.includes(c as McpClient)) clients.push(c as McpClient);
    } else unknown.push(n);
  }
  return { clients, unknown };
}

/**
 * Add denext's MCP server to an existing project: the `mcp` task in `deno.json` (a
 * comment-preserving splice, running the denext the project pins) and a `denext` entry in
 * each client's project-level config, merged beside any servers already there.
 *
 * @param dir The project root (must hold a `deno.json` / `deno.jsonc`).
 * @param cli The pinned CLI specifier the task runs.
 * @param options Clients, `--disable`, dry run, force.
 * @returns What was written, skipped, and refused.
 * @throws {Error} When the project has no `deno.json` / `deno.jsonc`, or it cannot be edited.
 */
export async function addMcp(
  dir: string,
  cli: string,
  options: AddMcpOptions = {},
): Promise<AddMcpResult> {
  const result: AddMcpResult = { written: [], skipped: [], errors: [] };
  const denoConfig = await denoJsonName(dir);
  await addMcpTask(dir, denoConfig, mcpTaskCommand(cli, options.disable), options, result);
  await writeMcpClientConfigs(dir, options, result, denoConfig);
  return result;
}

/** Splice the `mcp` task into `deno.json(c)` (replaced only with `force`). */
async function addMcpTask(
  dir: string,
  denoConfig: string,
  command: string,
  options: AddMcpOptions,
  result: AddMcpResult,
): Promise<void> {
  const path = join(dir, denoConfig);
  const source = await Deno.readTextFile(path);
  const doc = readJson(source) as { tasks?: Record<string, unknown> } | null;
  const current = doc?.tasks?.[MCP_TASK];
  if (current === command || (current !== undefined && options.force !== true)) {
    result.skipped.push(`${denoConfig} (task "${MCP_TASK}")`);
    return;
  }
  const edit = await setJsonValue(source, ["tasks", MCP_TASK], command);
  if (!edit.ok) throw new Error(`denext mcp: could not edit ${denoConfig}: ${edit.reason}`);
  if (options.dryRun !== true) await Deno.writeTextFile(path, edit.source);
  result.written.push(denoConfig);
}

/**
 * Write (or merge) each client's project-level config so it registers the `denext` server.
 * Another server in the same file is never touched; an existing `denext` entry is kept
 * unless `force`; a symlinked or unparseable file is reported, never rewritten.
 *
 * @param dir The project root.
 * @param options Clients, dry run, force.
 * @param result Accumulator for written / skipped / errors.
 * @param denoConfig The project's Deno config file name (named by Cursor's entry).
 */
export async function writeMcpClientConfigs(
  dir: string,
  options: AddMcpOptions,
  result: AddMcpResult,
  denoConfig = "deno.json",
): Promise<void> {
  for (const client of options.clients ?? DEFAULT_MCP_CLIENTS) {
    const rel = MCP_CLIENT_FILES[client];
    const abs = join(dir, rel);
    try {
      const next = await mergedClientFile(client, abs, denoConfig, options.force === true);
      if (next === null) {
        result.skipped.push(rel);
        continue;
      }
      if (options.dryRun !== true) {
        await Deno.mkdir(join(abs, ".."), { recursive: true });
        await Deno.writeTextFile(abs, next);
      }
      result.written.push(rel);
    } catch (error) {
      result.errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** The new text of a client's config, or null when it already registers denext. */
async function mergedClientFile(
  client: McpClient,
  abs: string,
  denoConfig: string,
  force: boolean,
): Promise<string | null> {
  const stat = await lstatOrNull(abs);
  if (stat === null) return mcpClientFile(client, denoConfig);
  if (stat.isSymlink) throw new Error("is a symlink; edit it by hand");
  const source = await Deno.readTextFile(abs);
  if (client === "codex") return mergedToml(source, force);
  if (source.trim() === "") return mcpClientFile(client, denoConfig);
  return await mergedJson(source, jsonClientConfig(client, denoConfig), force);
}

/** Splice the `denext` entry into a JSON(C) config, or null when it is already there. */
async function mergedJson(
  source: string,
  { rootKey, entry }: JsonClientConfig,
  force: boolean,
): Promise<string | null> {
  const have = existingEntry(parseObject(source), rootKey);
  if (have !== undefined && (!force || JSON.stringify(have) === JSON.stringify(entry))) return null;
  const edit = await setJsonValue(source, [rootKey, MCP_SERVER_NAME], entry);
  if (!edit.ok) throw new Error(edit.reason);
  return edit.source;
}

/** Parse a client config, refusing anything but a JSON(C) object. */
function parseObject(source: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = readJson(source);
  } catch {
    throw new Error("is not valid JSON; fix it, or add the server by hand");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("is not a JSON object");
  }
  return doc as Record<string, unknown>;
}

/** The `denext` entry under `rootKey`, if the config already has one. */
function existingEntry(doc: Record<string, unknown>, rootKey: string): unknown {
  const servers = doc[rootKey];
  if (servers === null || typeof servers !== "object") return undefined;
  return (servers as Record<string, unknown>)[MCP_SERVER_NAME];
}

/** A TOML table header line (`[x]` / `[[x]]`, optionally commented). */
const TOML_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;

/** Append (or, with `force`, replace) the Codex `[mcp_servers.denext]` table. */
function mergedToml(source: string, force: boolean): string | null {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === CODEX_HEADER);
  if (start === -1) {
    const sep = source === "" ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    return source + sep + CODEX_TABLE;
  }
  if (!force) return null;
  const text = replaceTomlTable(lines, start);
  return text === source ? null : text;
}

/** `lines` with the table opening at `start` (up to the next header) replaced by ours. */
function replaceTomlTable(lines: string[], start: number): string {
  let end = start + 1;
  while (end < lines.length && !TOML_HEADER.test(lines[end])) end++;
  const replaced = [...lines.slice(0, start), ...CODEX_TABLE.trimEnd().split("\n")];
  const rest = lines.slice(end);
  const out = rest.some((l) => l.trim() !== "") ? [...replaced, "", ...rest] : replaced;
  const joined = out.join("\n");
  return joined.endsWith("\n") ? joined : joined + "\n";
}

/** The project's Deno config file name, or an error when it has none. */
async function denoJsonName(dir: string): Promise<string> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    if (await lstatOrNull(join(dir, name))) return name;
  }
  throw new Error(`denext mcp: no deno.json in ${dir} (run it from a denext project).`);
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch {
    return null;
  }
}
