import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Getting started",
  description:
    "A denext project is a Deno project — no package.json, no node_modules, just a deno.json and an app/ directory.",
};

export default function GettingStarted() {
  return (
    <DocsShell
      active="getting-started"
      title="Getting started"
      lead="A denext project is a Deno project. No package.json, no node_modules — a deno.json and an app/ directory."
    >
      <h2>Install the CLI</h2>
      <p>
        Optional but recommended — it puts a <code>denext</code>{" "}
        command in your PATH, so every example below is one word instead of a URL:
      </p>
      <Code lang="sh">
        {`curl -fsSL https://denext.dev/install.sh | sh   # ~/.denext/bin/denext (macOS, Linux)
irm https://denext.dev/install.ps1 | iex         # Windows PowerShell: %USERPROFILE%\\.denext\\bin
# or, with Deno already installed:
deno install -A -g -n denext jsr:@denext/denext/cli`}
      </Code>
      <p>
        The binary is a CLI, not a second copy of the framework: inside a project it runs the denext
        that project pins in <code>deno.json</code> (a <code>deno run</code>{" "}
        child, so it needs a Deno), so it never silently swaps your app's framework version. Pin a
        version — <code>jsr:@denext/denext@^3.1.0</code>, as <code>denext create</code>{" "}
        writes — and that is what the binary defers to; an unversioned{" "}
        <code>jsr:@denext/denext</code>{" "}
        means "the latest published version", which is reproducible only until the next release.
        Every command on this page also works with nothing installed — replace <code>denext</code>
        {" "}
        with <code>deno run -A jsr:@denext/denext/cli</code>.
      </p>
      <p>
        The installer downloads the release archive for your platform (<code>
          denext-&lt;target&gt;.tar.gz
        </code>), verifies it against the release's <code>SHA256SUMS</code> (or the per-archive{" "}
        <code>&lt;archive&gt;.sha256</code>) and refuses to install without a checksum —{" "}
        <code>DENEXT_INSECURE=1</code> is the one loud override. It resolves the{" "}
        <em>latest stable</em>{" "}
        release: release candidates are GitHub prereleases and are never "latest", so pick one with
        {" "}
        <code>DENEXT_VERSION=v3.1.0-rc.1</code>{" "}
        if you want it. The latest-version lookup uses GitHub's API, which allows 60 anonymous
        requests an hour per IP: with <code>GITHUB_TOKEN</code> (or{" "}
        <code>GH_TOKEN</code>) set, both installers send it on that one <code>api.github.com</code>
        {" "}
        call (never on a download, and never print it), and when the API refuses they read the
        version from the <code>github.com/…/releases/latest</code>{" "}
        redirect instead, so a shared CI runner or office network still installs. Gatekeeper is not
        part of this path by design: a file fetched by <code>curl | sh</code>{" "}
        never carries the quarantine attribute (the script strips it anyway, for a binary that
        arrived by browser), so the macOS CLI binary is not stapled — a bare executable cannot be —
        and runs whether or not the release was signed. It <em>is</em>{" "}
        code-signed and notarized when the release was built with the Apple Developer ID secrets,
        and ships unsigned otherwise. On Windows, <code>install.ps1</code>{" "}
        does the same per-user with no administrator rights: it downloads{" "}
        <code>denext-x86_64-pc-windows-msvc.zip</code>, verifies it the same way, installs{" "}
        <code>denext.exe</code> to <code>%USERPROFILE%\.denext\bin</code> and adds that to your user
        {" "}
        <code>Path</code> (<code>DENEXT_NO_PATH=1</code> leaves it alone). Uninstall with{" "}
        <code>&amp; ([scriptblock]::Create((irm https://denext.dev/install.ps1))) -Uninstall</code>.
        Each release also attaches a Homebrew formula, a Scoop manifest and a winget manifest set.
      </p>

      <h2>Create a project</h2>
      <p>Scaffold a new app with the CLI:</p>
      <Code lang="sh">
        {`denext create my-app
cd my-app
deno task dev`}
      </Code>
      <p>
        That writes a{" "}
        <code>deno.json</code>, a root layout, a home page that is a Server Component, one{" "}
        <code>"use client"</code> counter island (<code>app/counter.tsx</code>) it renders, and the
        {" "}
        <code>.vscode</code> files that turn on the Deno language server (see{" "}
        <a href="#editor-setup">Editor setup</a>; <code>--no-vscode</code> skips them).{" "}
        <code>--template minimal</code> is a bare page. Or start by hand — the minimum is a{" "}
        <code>deno.json</code>, a root layout, and a page.
      </p>

      <h2>deno.json</h2>
      <Code lang="jsonc">
        {`{
  "tasks": {
    "dev": "deno run -A jsr:@denext/denext@^3.1.0/cli dev .",
    "build": "deno run -A jsr:@denext/denext@^3.1.0/cli build .",
    "start": "deno run -A jsr:@denext/denext@^3.1.0/cli start ."
  },
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "denext" },
  "imports": { "denext": "jsr:@denext/denext@^3.1.0" }
}`}
      </Code>
      <p>
        The version in <code>imports</code> is the project's pin — what the <code>denext</code>{" "}
        binary defers to — and the tasks name the same version, so <code>deno task build</code> and
        {" "}
        <code>denext build</code> run the same framework. <code>denext create</code> writes both.
      </p>

      <h2>Your first page</h2>
      <Code lang="tsx">
        {`// app/layout.tsx
export default function RootLayout({ children }) {
  return <div class="app">{children}</div>;
}

// app/page.tsx
export default function Home() {
  return <h1>Hello from denext</h1>;
}`}
      </Code>

      <Callout kind="note">
        Server Components are the default. Add <code>"use client"</code>{" "}
        at the top of a file only for interactivity — everything else stays on the server and ships
        no JavaScript.
      </Callout>

      <h2 id="server-and-client">Server and client code — what ships to the browser</h2>
      <p>
        There is one model, and it is the App Router's. A file under <code>app/</code> is a{" "}
        <strong>Server Component</strong>{" "}
        unless it says otherwise: it runs only on the server, it can be <code>async</code>{" "}
        and await a database or a <code>fetch</code>{" "}
        directly, and none of its code reaches the browser. Interactivity — state, effects, event
        handlers, any hook — lives in a file that opens with <code>"use client"</code>: a{" "}
        <strong>client island</strong>{" "}
        that is server-rendered like everything else, then bundled and hydrated in the browser. This
        is exactly what <code>denext create</code> scaffolds and{" "}
        <code>
          denext generate component
        </code>{" "}
        writes:
      </p>
      <Code lang="tsx">
        {`// app/page.tsx — a Server Component: no "use client", no hooks, ships no JS
import { listNotes } from "../lib/db.ts"; // node:sqlite — stays on the server
import { Counter } from "./counter.tsx";

export default async function Home() {
  const notes = await listNotes();
  return (
    <>
      <ul>{notes.map((n) => <li key={n.id}>{n.title}</li>)}</ul>
      <Counter initial={notes.length} />
    </>
  );
}

// app/counter.tsx — the island: the one file the browser runs
"use client";
import { useState } from "denext";

export function Counter({ initial }: { initial: number }) {
  const [n, setN] = useState(initial);
  return <button type="button" onClick={() => setN(n + 1)}>{n}</button>;
}`}
      </Code>
      <h3>What crosses the boundary</h3>
      <p>
        The page renders the island with props, and those props travel as data — so they must be
        {" "}
        <strong>serialisable</strong>: strings, numbers, booleans, plain objects and arrays, Dates,
        Maps, Sets, URLs, promises (read them with <code>use()</code>), and <code>children</code>
        {" "}
        (which may itself contain Server Components). Two kinds of function cross as a{" "}
        <em>reference</em>: a <strong>Server Action</strong> (an export of a{" "}
        <code>"use server"</code> module, passed as <code>action</code>{" "}
        to a form or as any prop) and a Live channel. A plain function does not — an{" "}
        <code>{"onClick={() => …}"}</code>{" "}
        passed from a Server Component to a client component is dropped, and in dev the renderer
        warns naming the component and the prop. Move the handler into the island, or hand the
        island a Server Action.
      </p>
      <h3>Modules that must never ship</h3>
      <p>
        A <code>lib/db.ts</code> that opens <code>node:sqlite</code> or reads{" "}
        <code>Deno.env.get(…)</code> is{" "}
        <strong>server-only</strong>. Imported from a Server Component it is fine; imported from
        {" "}
        <code>"use client"</code>{" "}
        code it would be bundled for the browser. denext fails that build —{" "}
        <code>denext build</code> / <code>export</code>{" "}
        name the module, why it is server-only and the entry that pulled it in, and{" "}
        <code>denext dev</code>{" "}
        refuses the route's entry with the same message instead of letting the page fail in the
        browser. Mark the module so the intent is explicit and the failure is about the marker
        rather than an incidental <code>node:</code> import:
      </p>
      <Code lang="ts">
        {`// lib/db.ts
import { serverOnly } from "denext";
serverOnly(); // or \`import "server-only"\` in a migrated / --compatibility app

import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");
export const listNotes = () => db.prepare("SELECT * FROM notes").all();`}
      </Code>
      <p>
        Type-only imports (<code>import type {"{ Note }"} from "../lib/db.ts"</code>) are erased and
        never count — an island can share the page's types freely.
      </p>
      <h3>The compatibility path: a whole route as client code</h3>
      <p>
        denext also runs a route that has <em>no</em> <code>"use client"</code>{" "}
        boundary but does use hooks or event handlers directly in <code>page.tsx</code>{" "}
        or a layout — the whole route (page, layouts, everything they import) is then bundled and
        hydrated as one unit. That is a <strong>compatibility mode</strong>{" "}
        for apps written that way (many migrated ones are); it works, it navigates correctly, and
        {" "}
        <a href="/docs/architecture#soft-navigation-two-mechanisms-one-correct-behavior">
          Architecture
        </a>{" "}
        explains what it costs. Do not write new code this way: the moment such a route imports a
        server-only module, the build fails as above, and the fix is the model on this page — keep
        the page a Server Component and move the interactive part into an island. See{" "}
        <a href="/docs/client-components">Client Components</a>,{" "}
        <a href="/docs/server-actions">Server Actions</a> and{" "}
        <a href="/docs/islands">Islands &amp; hydration</a> for the rest.
      </p>

      <h2 id="editor-setup">Editor setup</h2>
      <p>
        A denext project resolves <code>denext</code> through <code>deno.json</code>'s{" "}
        <code>imports</code>, which the built-in TypeScript server in VS Code does not read — it
        would flag every <code>denext</code> import as unresolved while <code>deno check</code>{" "}
        passes. <code>denext create</code> (and <code>denext migrate</code>) write{" "}
        <code>.vscode/settings.json</code> with <code>"deno.enable": true</code> and{" "}
        <code>.vscode/extensions.json</code> recommending{" "}
        <code>denoland.vscode-deno</code>; install the extension when prompted and the editor uses
        the same resolution, types and lint plugin as the CLI. Any editor that speaks the Deno
        language server works the same way. Type-check from the terminal with{" "}
        <code>deno check app/</code>, and lint with <code>deno lint</code> — the{" "}
        <code>denext/*</code> rules (rules-of-hooks, directive placement) run there too.
      </p>

      <h2 id="fallow">Code health gate (fallow)</h2>
      <p>
        <code>denext create my-app --fallow</code> (or the picker's fallow entry) adds{" "}
        <a href="https://docs.fallow.tools">fallow</a>, the dead-code, duplication and complexity
        gate denext itself is built under. It writes a <code>fallow.toml</code>{" "}
        that declares denext's path-loaded files (routes, <code>denext.config.ts</code>,{" "}
        <code>middleware.ts</code>, <code>tasks/*.ts</code>, …) as entry points, a{" "}
        <code>.githooks/pre-commit</code> gate, the coverage converter, and an{" "}
        <code>AGENTS.md</code>{" "}
        telling coding agents to run the gate before committing. fallow runs from npm through Deno
        at a pinned version, so nothing is installed globally:
      </p>
      <Code lang="sh">
        {`deno task fallow:audit      # the changed-code gate: exit 1 on a "fail" verdict
deno task hooks:install     # git runs that gate before every commit (git config core.hooksPath)
deno task fallow            # dead code + duplication + health over the whole project
deno task coverage:fallow   # deno test --coverage → coverage/coverage-final.json (measured CRAP)`}
      </Code>
      <p>
        The hook is installed only when you run <code>hooks:install</code>{" "}
        — the scaffold never touches{" "}
        <code>.git</code>. To add the same setup to an existing project, run{" "}
        <code>denext fallow init</code> (it writes only the missing files and splices the tasks into
        {" "}
        <code>deno.json</code>
        ). In CI, run the gate against the pull request's base branch:
      </p>
      <Code lang="yaml">
        {`- uses: actions/checkout@v4
  with: { fetch-depth: 0 } # the audit diffs against the base branch
- uses: denoland/setup-deno@v2
- run: deno task fallow:audit --base origin/\${{ github.base_ref }}`}
      </Code>
      <p>
        Prefer a global binary (it also lets fallow's own <code>fallow agent install</code>{" "}
        wire editor and agent hooks)? <code>npm install -g fallow</code> or{" "}
        <code>cargo install fallow-cli</code> works with the same <code>fallow.toml</code>.
      </p>

      <h2 id="mcp">Coding agents (MCP)</h2>
      <p>
        <code>denext create my-app --mcp</code>{" "}
        (pre-checked in the interactive picker) registers denext's{" "}
        <a href="/docs/mcp">MCP server</a> for the project: a <code>deno task mcp</code>{" "}
        that runs the denext version <code>deno.json</code> pins, wired into <code>.mcp.json</code>
        {" "}
        (Claude Code), <code>.vscode/mcp.json</code> and{" "}
        <code>.cursor/mcp.json</code>. Agents opened in the project can then lint snippets for
        Next-isms, search the docs offline, scaffold and render routes. For an existing project, run
        {" "}
        <code>denext mcp init</code> (<code>--clients all</code>{" "}
        adds Gemini CLI and Codex); it merges into config files that already list other servers.
      </p>

      <h2>Coming from Next.js?</h2>
      <p>
        The file conventions, hooks, and <code>app/</code>{" "}
        router are the same. The differences are small: imports come from <code>denext</code> (not
        {" "}
        <code>react</code>), there's a <code>deno.json</code> instead of{" "}
        <code>package.json</code>, and server helpers live in{" "}
        <code>denext/server</code>. A drop-in migration tool (<code>
          denext migrate
        </code>) aliases <code>next/*</code> and <code>react</code>{" "}
        so most existing App Router apps run unchanged.
      </p>
    </DocsShell>
  );
}
