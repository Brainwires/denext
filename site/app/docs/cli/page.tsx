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
    { id: "build-locks", text: "Concurrency and build locks", level: 2 as const },
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

      <h2 id="build-locks">Concurrency and build locks</h2>
      <p>
        Two denext commands writing the same output never interleave: like Cargo, a verb that writes
        build output holds an OS file lock on it for the whole command, and a second invocation
        prints one line and waits for the first to finish:
      </p>
      <Code lang="sh">
        {`$ denext build   # while another \`denext build\` runs here
    Blocking waiting for file lock on build directory .denext (/app/.denext/.denext-lock) — held by another denext process; Ctrl-C to abort`}
      </Code>
      <p>
        The locks are real advisory OS locks (<code>flock</code> on macOS/Linux,{" "}
        <code>LockFileEx</code> on Windows) on files in <code>.denext/</code>
        , released by the OS when the process exits — a crashed or killed build leaves no stale lock
        to clean up, and there is no lock-breaking flag because none is ever needed. As in Cargo,
        the build directory (<code>.denext/</code>
        ) and the output directories are locked separately, so a verb takes only what it writes:
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>Command</th>
            <th>Locks</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>build</code>, <code>analyze</code>, <code>content build|list|validate</code>
            </td>
            <td>
              build directory, exclusive (for <code>build</code>, <code>.denext/</code>{" "}
              is also the output, so it is locked once)
            </td>
          </tr>
          <tr>
            <td>
              <code>export</code>, <code>desktop build</code>, <code>desktop run</code>
              {"'"}s export
            </td>
            <td>
              build directory + <code>out/</code>, exclusive (<code>desktop run</code>{" "}
              releases them before the window opens)
            </td>
          </tr>
          <tr>
            <td>
              <code>desktop package</code>, <code>mobile build</code>
            </td>
            <td>
              <code>dist/</code> / <code>dist/mobile/</code> (or <code>--out</code>), exclusive; the
              {" "}
              <code>denext export</code> they run takes the build directory and <code>out/</code>
              {" "}
              itself
            </td>
          </tr>
          <tr>
            <td>
              <code>test --coverage[=dir]</code>
            </td>
            <td>the coverage directory, exclusive</td>
          </tr>
          <tr>
            <td>
              <code>dev</code>
            </td>
            <td>
              build directory, exclusive, per rebuild (startup codegen, typed modules, plugin
              prepare re-runs) — never for the whole session
            </td>
          </tr>
          <tr>
            <td>
              <code>doctor</code>
            </td>
            <td>build directory, shared (readers run side by side; a build is waited out)</td>
          </tr>
          <tr>
            <td>
              <code>start</code>, <code>check</code>, <code>lint</code>, <code>fmt</code>
            </td>
            <td>none (builds swap their output in atomically for a running server)</td>
          </tr>
        </tbody>
      </table>
      <p>
        The pinned Deno Desktop runtime cache (<code>
          &lt;DENO_DIR&gt;/denext-desktop-runtime/
        </code>) uses Cargo{"'"}s package-cache modes: reading a cached runtime is shared, a
        download is exclusive among downloaders only, and replacing a bad tree excludes everyone.
        Locks are always taken in one fixed order — package outputs, build directory, output
        directories, then the runtime cache (its mutate lock before its download lock) — so two
        invocations can never each hold what the other waits for. A plugin verb declares its locks
        the same way, with the <code>locks</code> field of its <code>CommandSpec</code>.
      </p>
      <p>
        A wait has no limit unless <code>DENEXT_LOCK_TIMEOUT=&lt;seconds&gt;</code>{" "}
        is set: then the command fails once that long has passed, naming the lock file (useful in
        CI). A filesystem that cannot lock at all (some network mounts) proceeds unlocked with one
        warning, as Cargo does; so does a shared lock — <code>doctor</code>{" "}
        on a read-only checkout — whose lock file cannot be created.
      </p>

      <div class="mcp-tools">
        {cli.commands.map((c) => <Verb key={c.name} c={c} />)}
      </div>
    </DocsShell>
  );
}
