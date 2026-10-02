import { Code, DocsShell } from "../../../components/ui.tsx";
import mcp from "./mcp.json" with { type: "json" };

export const metadata = {
  title: "MCP server",
  description:
    "denext ships a first-party Model Context Protocol server — denext mcp — so AI coding agents get denext right the first time: lint snippets, map imports, scaffold, render routes, and read the running dev server.",
};

const SETUP = `# with the denext CLI installed
denext mcp

# or with nothing installed at all
deno run -A jsr:@denext/denext/cli mcp`;

const PROJECT_INSTALL = `# a new app: the picker pre-checks it, or pass the flag
denext create my-app --mcp

# an existing app
denext mcp init                          # Claude Code, VS Code, Cursor
denext mcp init --clients all            # + Gemini CLI, Codex
denext mcp init --disable rag --dry-run  # bake --disable into the task; show the plan`;

const PROJECT_TASK = `// deno.json — the one place the version lives
"tasks": {
  "mcp": "deno run -A jsr:@denext/denext@^<version>/cli mcp" // the version "imports" pins
}

// .mcp.json (Claude Code) — every client runs the task, never a version
{ "mcpServers": { "denext": { "type": "stdio", "command": "deno", "args": ["task", "mcp"] } } }`;

/** Each client's project-level file, the shape written, and the format's source. */
const CLIENTS: { name: string; file: string; shape: string; doc: string }[] = [
  {
    name: "Claude Code",
    file: ".mcp.json",
    shape: '"mcpServers" → { type: "stdio", command, args }',
    doc: "https://code.claude.com/docs/en/mcp",
  },
  {
    name: "VS Code (Copilot)",
    file: ".vscode/mcp.json",
    shape: '"servers" → { type: "stdio", command, args } (cwd: the workspace folder)',
    doc: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
  },
  {
    name: "Cursor",
    file: ".cursor/mcp.json",
    shape: '"mcpServers" → args name ${workspaceFolder}/deno.json, so any working directory works',
    doc: "https://cursor.com/docs/context/mcp",
  },
  {
    name: "Gemini CLI (opt-in)",
    file: ".gemini/settings.json",
    shape: '"mcpServers" → { command, args }',
    doc: "https://geminicli.com/docs/tools/mcp-server/",
  },
  {
    name: "Codex (opt-in)",
    file: ".codex/config.toml",
    shape: "[mcp_servers.denext] table; Codex reads it only for a trusted project",
    doc: "https://developers.openai.com/codex/mcp",
  },
];

export default function Mcp() {
  const toc = [
    { id: "setup", text: "Setup", level: 2 as const },
    { id: "install-in-a-project", text: "Install in a project", level: 2 as const },
    { id: "offline-docs", text: "The docs, offline", level: 2 as const },
    { id: "tools", text: "Tools", level: 2 as const },
    ...mcp.tools.map((t) => ({ id: t.name, text: t.name, level: 3 as const })),
    { id: "resources", text: "Resources", level: 2 as const },
  ];
  return (
    <DocsShell
      active="mcp"
      title="MCP server"
      lead={`A first-party Model Context Protocol server exposing ${mcp.tools.length} tools + ${mcp.resources.length} resources, so an agent can ground itself in denext instead of guessing Next.js.`}
      toc={toc}
    >
      <p>
        <code>denext mcp</code>{" "}
        speaks MCP over stdio (newline-delimited JSON-RPC 2.0 — no SDK, no npm). Configure it as an
        MCP server in your client (Claude Code, Cursor, …) and the agent can call denext's own
        tooling in-process: the same functions the CLI uses, so behavior matches.
      </p>
      <p>
        This page is generated from the server's live tool registry, so it always matches what{" "}
        <code>tools/list</code> returns.
      </p>

      <h2 id="setup">Setup</h2>
      <Code lang="bash">{SETUP}</Code>

      <h2 id="install-in-a-project">Install in a project</h2>
      <p>
        Commit the server with the app, so every agent opened in the repository finds it with
        nothing installed globally:
      </p>
      <Code lang="bash">{PROJECT_INSTALL}</Code>
      <p>
        It adds an <code>mcp</code> task to <code>deno.json</code>{" "}
        that runs the denext CLI at the same specifier the project's import map pins (resolved
        through its <code>deno.lock</code>), and registers <code>deno task mcp</code> as the{" "}
        <code>denext</code>{" "}
        server in each client's project-level config. No client file names a version, so the server
        always matches the framework the app builds with, and upgrading denext in{" "}
        <code>deno.json</code> upgrades it too. <code>deno</code>{" "}
        is a real executable on Windows as well (no <code>cmd /c</code> wrapper), and{" "}
        <code>deno task</code> finds <code>deno.json</code>{" "}
        from any directory inside the project and runs the task from the project root.
      </p>
      <Code lang="jsonc">{PROJECT_TASK}</Code>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>File</th>
            <th>What is written</th>
          </tr>
        </thead>
        <tbody>
          {CLIENTS.map((c) => (
            <tr key={c.file}>
              <td>
                <a href={c.doc}>{c.name}</a>
              </td>
              <td>
                <code>{c.file}</code>
              </td>
              <td>{c.shape}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        An existing file keeps its other servers and its comments (the entry is spliced in), and a
        re-run changes nothing. An existing <code>denext</code> entry or <code>mcp</code>{" "}
        task is kept unless you pass{" "}
        <code>--force</code>; a file that is not valid JSON is reported and left alone. Windsurf and
        Zed are not written: neither documents a project-level MCP file. Claude Code asks you to
        approve a project server the first time it starts, and the first start downloads the pinned
        denext from JSR (later starts are cached). With <code>--fallow</code> as well, the generated
        {" "}
        <code>AGENTS.md</code> lists which tool to reach for when.
      </p>

      <h2 id="offline-docs">The docs, offline</h2>
      <p>
        The whole manual ships inside the package: every page of these docs (split by section), the
        root guides (features, known limitations and differences, recent changelog entries) and the
        full API reference. An agent never has to fetch denext.dev to answer a denext question:
      </p>
      <ul>
        <li>
          <code>denext_search_docs</code> ranks guide sections and API symbols together (pass{" "}
          <code>kind: "guide"</code> or <code>kind: "api"</code> to narrow it); each hit carries a
          {" "}
          <code>read:</code> ref.
        </li>
        <li>
          <code>denext_read_docs</code> returns a whole page (<code>desktop-runtime</code>,{" "}
          <code>/docs/deployment-targets</code>), one section{" "}
          (<code>desktop#desktop-notifications</code>) or a symbol's full docs{" "}
          (<code>api:denext/useApi</code>) as Markdown, and lists the closest pages when a slug is
          unknown.
        </li>
        <li>
          The same pages are MCP resources: <code>denext://docs</code> lists them and{" "}
          <code>denext://docs/&lt;slug&gt;</code> reads one.
        </li>
      </ul>
      <p>
        The corpus is regenerated by <code>deno task docs:corpus</code>{" "}
        (part of the docs build and the release), and a test fails when it is stale against its
        sources.
      </p>

      <h2 id="tools">Tools</h2>
      <div class="mcp-tools">
        {mcp.tools.map((t) => (
          <div key={t.name} class="mcp-tool">
            <h3 id={t.name}>
              <code>{t.name}</code>
            </h3>
            <p>{t.description}</p>
            {t.params.length
              ? (
                <ul class="mcp-params">
                  {t.params.map((p) => (
                    <li key={p.name}>
                      <code>{p.name}</code>{" "}
                      <span class="mcp-type">
                        {p.type}
                        {p.required ? " · required" : ""}
                      </span>
                      {p.description ? ` — ${p.description}` : ""}
                    </li>
                  ))}
                </ul>
              )
              : <p class="mcp-noparams">No parameters.</p>}
          </div>
        ))}
      </div>

      <h2 id="resources">Resources</h2>
      <p>Documentation an agent can read to ground itself:</p>
      <ul class="mcp-resources">
        {mcp.resources.map((r) => (
          <li key={r.uri}>
            <code>{r.uri}</code> — <strong>{r.name}.</strong> {r.description}
          </li>
        ))}
      </ul>
    </DocsShell>
  );
}
