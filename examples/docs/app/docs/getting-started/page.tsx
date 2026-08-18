import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export default function GettingStarted() {
  return (
    <DocsShell
      active="getting-started"
      title="Getting started"
      lead="A denext project is a Deno project. No package.json, no node_modules — a deno.json and an app/ directory."
    >
      <h2>Create a project</h2>
      <p>Scaffold a new app with the CLI:</p>
      <Code lang="sh">
        {`deno run -A jsr:@denext/denext/cli create my-app
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
        <code>denext/server</code>. A drop-in migration tool (<code>denext migrate</code>) aliases
        {" "}
        <code>next/*</code> and <code>react</code> so an existing App Router app runs unchanged.
      </p>
    </DocsShell>
  );
}
