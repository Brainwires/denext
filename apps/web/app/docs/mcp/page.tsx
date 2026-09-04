import { Code, DocsShell } from "../../../components/ui.tsx";
import mcp from "./mcp.json" with { type: "json" };

export const metadata = {
  title: "MCP server",
  description:
    "denext ships a first-party Model Context Protocol server — deno run -A jsr:@denext/denext/cli mcp — so AI coding agents get denext right the first time: lint snippets, map imports, scaffold, render routes, and read the running dev server.",
};

const SETUP = `# stand-alone
deno run -A jsr:@denext/denext/cli mcp

# or, inside a denext project
denext mcp`;

export default function Mcp() {
  const toc = [
    { id: "setup", text: "Setup", level: 2 as const },
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
