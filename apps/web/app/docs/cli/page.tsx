import { Code, DocsShell } from "../../../components/ui.tsx";
import cliJson from "./cli.json" with { type: "json" };

export const metadata = {
  title: "CLI reference",
  description:
    "Every built-in denext verb with its flags and positionals — dev, build, start, export, migrate, generate, doctor, analyze, profile, desktop, plugin, patch, task, mcp and the rest — generated from the command registry.",
};

interface Flag {
  name: string;
  alias?: string;
  altNames?: string[];
  type: string;
  valueName?: string;
  default?: string | number | boolean;
  description: string;
}

interface Positional {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
}

interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  description?: string;
  flags: Flag[];
  positionals: Positional[];
}

const cli = cliJson as unknown as { globalFlags: Flag[]; commands: Command[] };

/** `--port, -p <port>` — the label column of a flags table. */
function flagLabel(f: Flag): string {
  const alt = (f.altNames ?? []).map((n) => `, --${n}`).join("");
  const alias = f.alias ? `, -${f.alias}` : "";
  return `--${f.name}${alias}${alt}${f.valueName ? " " + f.valueName : ""}`;
}

function FlagTable({ flags }: { flags: Flag[] }) {
  return (
    <table class="table">
      <thead>
        <tr>
          <th>Flag</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {flags.map((f) => (
          <tr key={f.name}>
            <td>
              <code>{flagLabel(f)}</code>
            </td>
            <td>
              {f.type}
              {f.default !== undefined ? ` · default ${JSON.stringify(f.default)}` : ""}
            </td>
            <td>{f.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Positionals({ positionals }: { positionals: Positional[] }) {
  return (
    <ul class="mcp-params">
      {positionals.map((p) => (
        <li key={p.name}>
          <code>{p.name}</code> <span class="mcp-type">{p.required ? "required" : "optional"}</span>
          {p.description ? ` — ${p.description}` : ""}
        </li>
      ))}
    </ul>
  );
}

function Verb({ c }: { c: Command }) {
  return (
    <div class="mcp-tool">
      <h2 id={c.name}>
        <code>denext {c.name}</code>
      </h2>
      <p>
        {c.summary}
        {c.aliases?.length ? ` (also: ${c.aliases.map((a) => `denext ${a}`).join(", ")})` : ""}
      </p>
      <Code lang="sh">{c.description ? `${c.usage}\n\n${c.description}` : c.usage}</Code>
      {c.positionals.length ? <Positionals positionals={c.positionals} /> : null}
      {c.flags.length ? <FlagTable flags={c.flags} /> : <p class="mcp-noparams">No flags.</p>}
    </div>
  );
}

export default function Cli() {
  const toc = [
    { id: "global-flags", text: "Global flags", level: 2 as const },
    ...cli.commands.map((c) => ({ id: c.name, text: `denext ${c.name}`, level: 2 as const })),
  ];
  return (
    <DocsShell
      active="cli"
      title="CLI reference"
      lead="Every built-in denext verb with its flags and positionals — generated from the command registry, so it never drifts from denext --help."
      toc={toc}
    >
      <p>
        The denext CLI is a declarative registry: each verb is a <code>CommandSpec</code>{" "}
        that declares its flags and positionals as data, so{" "}
        <code>--help</code>, "did you mean" suggestions, shell completions (<code>
          denext completions
        </code>) and this page are all derived from one source. The {cli.commands.length}{" "}
        verbs below are the built-ins; run <code>denext &lt;command&gt; --help</code>{" "}
        for the same information in your terminal.
      </p>
      <p>
        Plugin-contributed verbs — <code>openapi</code>, <code>graphql</code>, <code>content</code>
        {" "}
        and <code>htmx</code>{" "}
        — are discovered lazily from a project's config, so they are not listed here; see{" "}
        <a href="/docs/openapi">OpenAPI</a>, <a href="/docs/graphql">GraphQL</a>,{" "}
        <a href="/docs/content-collections">content collections</a> and{" "}
        <a href="/docs/htmx">htmx</a>. For how to get a <code>denext</code>{" "}
        binary (run it straight from JSR, install it globally, or compile it), see{" "}
        <a href="https://github.com/Brainwires/denext#the-denext-command">the README</a>.
      </p>
      <p>
        Two more tokens are handled by the parser rather than a verb: <code>denext version</code>
        {" "}
        (also <code>--version</code>/<code>-v</code>) prints the version, and{" "}
        <code>denext help [command]</code> (also <code>--help</code>/<code>-h</code>) prints help.
      </p>

      <h2 id="global-flags">Global flags</h2>
      <p>Accepted on every command, before or after the verb:</p>
      <FlagTable flags={cli.globalFlags} />

      <div class="mcp-tools">
        {cli.commands.map((c) => <Verb key={c.name} c={c} />)}
      </div>
    </DocsShell>
  );
}
