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
        Or start by hand — the minimum is a <code>deno.json</code>, a root layout, and a page.
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
