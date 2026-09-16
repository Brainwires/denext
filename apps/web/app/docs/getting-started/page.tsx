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
        {`curl -fsSL https://denext.dev/install.sh | sh   # ~/.denext/bin/denext
# or, with Deno already installed:
deno install -A -g -n denext jsr:@denext/denext/cli`}
      </Code>
      <p>
        The binary is a CLI, not a second copy of the framework: inside a project it runs the denext
        that project pins, so it never silently swaps your app's framework version. Every command on
        this page also works with nothing installed — replace <code>denext</code> with{" "}
        <code>deno run -A jsr:@denext/denext/cli</code>.
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
    "dev": "deno run -A jsr:@denext/denext/cli dev .",
    "build": "deno run -A jsr:@denext/denext/cli build .",
    "start": "deno run -A jsr:@denext/denext/cli start ."
  },
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "denext" },
  "imports": { "denext": "jsr:@denext/denext" }
}`}
      </Code>

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
