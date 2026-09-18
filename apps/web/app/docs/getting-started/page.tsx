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
# or, with Deno already installed (Windows too):
deno install -A -g -n denext jsr:@denext/denext/cli`}
      </Code>
      <p>
        The binary is a CLI, not a second copy of the framework: inside a project it runs the denext
        that project pins in <code>deno.json</code> (a <code>deno run</code>{" "}
        child, so it needs a Deno), so it never silently swaps your app's framework version. Pin a
        version — <code>jsr:@denext/denext@^2.5.0</code>, as <code>denext create</code>{" "}
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
        <code>DENEXT_VERSION=v2.5.0-rc.6</code>{" "}
        if you want it. Gatekeeper is not part of this path by design: a file fetched by{" "}
        <code>curl | sh</code>{" "}
        never carries the quarantine attribute (the script strips it anyway, for a binary that
        arrived by browser), so the macOS CLI binary is not stapled — a bare executable cannot be —
        and runs whether or not the release was signed. It <em>is</em>{" "}
        code-signed and notarized when the release was built with the Apple Developer ID secrets,
        and ships unsigned otherwise. On Windows, download{" "}
        <code>denext-x86_64-pc-windows-msvc.zip</code> from the release page or use the{" "}
        <code>deno install</code> line.
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
    "dev": "deno run -A jsr:@denext/denext@^2.5.0/cli dev .",
    "build": "deno run -A jsr:@denext/denext@^2.5.0/cli build .",
    "start": "deno run -A jsr:@denext/denext@^2.5.0/cli start ."
  },
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "denext" },
  "imports": { "denext": "jsr:@denext/denext@^2.5.0" }
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
