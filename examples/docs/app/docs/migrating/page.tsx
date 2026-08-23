import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = { title: "Migrating from Next.js" };

export default function Migrating() {
  return (
    <DocsShell
      active="migrating"
      title="Migrating from Next.js"
      lead="If you know the App Router, you already know denext. The conventions are the same; the runtime underneath is Deno with its own small React."
    >
      <h2>The drop-in path</h2>
      <p>
        Run the migration tool in an existing App Router project. It writes a <code>deno.json</code>
        {" "}
        that aliases <code>next/*</code> and <code>react</code>{" "}
        to denext, so most apps run unchanged.
      </p>
      <Code lang="sh">
        {`deno run -A jsr:@denext/denext/cli migrate
deno task dev`}
      </Code>
      <p>
        Your <code>app/</code>{" "}
        directory, file conventions (layout/page/loading/error/not-found), hooks, Server Components,
        Server Actions, and metadata all work as-is. Imports keep pointing at <code>next/*</code>
        {" "}
        and <code>react</code> — the alias resolves them to denext.
      </p>

      <h2>What's the same</h2>
      <ul>
        <li>
          The App Router: <code>app/page.tsx</code>, <code>layout.tsx</code>,{" "}
          <code>loading.tsx</code>, <code>error.tsx</code>,{" "}
          <code>not-found.tsx</code>, parallel &amp; intercepting routes.
        </li>
        <li>
          Hooks and APIs: the React hook set (state, effects, refs, context) plus{" "}
          <code>use()</code>, <code>useRouter</code>, <code>cookies()</code>,{" "}
          <code>headers()</code>, <code>redirect()</code>, <code>notFound()</code>,{" "}
          <code>forbidden()</code>.
        </li>
        <li>
          Server Actions (<code>"use server"</code>), <code>generateMetadata</code>,{" "}
          <code>middleware.ts</code>, <code>next/image</code>, <code>next/font</code>,{" "}
          <code>next/og</code>, ISR &amp; Cache Components.
        </li>
      </ul>

      <h2>What's different</h2>
      <ul>
        <li>
          <strong>
            No <code>package.json</code> / <code>node_modules</code>
          </strong>{" "}
          — a <code>deno.json</code> and an import map instead.
        </li>
        <li>
          <strong>Runtime is Deno</strong>{" "}
          — everything runs on one full server runtime. There is no separate edge runtime;{" "}
          <code>export const runtime = "edge"</code> is an accepted no-op.
        </li>
        <li>
          <strong>
            Server helpers live in <code>denext/server</code>
          </strong>{" "}
          (the equivalent of Next's server-only exports).
        </li>
        <li>
          <strong>Its own React</strong> — a React 19-compatible core, not the npm{" "}
          <code>react</code>{" "}
          package. Most libraries work via the compat layer; deeply React-internal packages may not.
        </li>
      </ul>

      <Callout kind="note">
        Starting fresh instead? You don't need the alias — import from <code>denext</code> and{" "}
        <code>denext/server</code> directly. See{" "}
        <a href="/docs/getting-started">Getting started</a>.
      </Callout>

      <h2>Deploying the result</h2>
      <p>
        Build and serve with the denext CLI — <code>deno task build</code> then{" "}
        <code>deno task start</code>{" "}
        — or static-export a fully-static site. Any host that runs Deno works. See{" "}
        <a href="/docs/deploy">Deployment</a>.
      </p>

      <Callout kind="warn">
        Behavioral divergences are documented honestly. Before a large migration, skim{" "}
        <a
          href="https://github.com/Brainwires/denext/blob/main/KNOWN-LIMITATIONS.md"
          rel="noopener"
        >
          KNOWN-LIMITATIONS
        </a>{" "}
        for the small set of edges where denext differs from Next.
      </Callout>
    </DocsShell>
  );
}
