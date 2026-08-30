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
        to denext, so most apps run unchanged. By default <code>migrate</code>{" "}
        <strong>only creates config files</strong>{" "}
        — it never rewrites your source. Your imports keep pointing at <code>next/*</code> and{" "}
        <code>react</code>; the alias resolves them to denext.
      </p>
      <Code lang="sh">
        {`deno run -A jsr:@denext/denext/cli migrate
deno task dev`}
      </Code>
      <p>
        <code>migrate</code> also writes a <code>.gitignore</code> for the artifacts it generates —
        {" "}
        <code>.denext/</code> (build cache), <code>out/</code> (the static export), and (with{" "}
        <code>--desktop</code>) <code>desktop-icon.png</code>{" "}
        — creating the file if absent and appending only the missing lines (it never reorders or
        removes your entries).
      </p>
      <Callout kind="note">
        Migrating a project that already has <code>node_modules</code>{" "}
        installed (most real apps)? Add <code>--node-modules-dir=none</code> to the migrate command:
        {" "}
        <code>
          deno run --node-modules-dir=none -A jsr:@denext/denext/cli migrate
        </code>. Without it, Deno runs in manual-<code>node_modules</code>{" "}
        mode and can't resolve the CLI's own build dependencies. (Your app's{" "}
        <code>node_modules</code>{" "}
        is untouched either way — the compat layer still loads your npm React libraries from it.)
      </Callout>
      <p>
        Your <code>app/</code>{" "}
        directory, file conventions (layout/page/loading/error/not-found), hooks, Server Components,
        Server Actions, and metadata all work as-is. To also rewrite the source to import from{" "}
        <code>denext</code> directly (dropping the alias), pass <code>--codemod</code> (add{" "}
        <code>--yes</code> to skip the confirmation), or run the standalone{" "}
        <code>denext codemod</code> later.
      </p>

      <h2>Migrating a Vite SPA</h2>
      <p>
        <code>migrate</code> also handles a client-only <strong>Vite React SPA</strong> (a{" "}
        <code>vite.config.*</code> with React and no{" "}
        <code>next.config.*</code>). It detects the shape and writes a{" "}
        <a href="/docs/spa">SPA-mode</a> config instead: <code>mode: "spa"</code> +{" "}
        <code>compatibilityMode: true</code>, your <code>~/</code> path alias from{" "}
        <code>tsconfig.json</code>, a <code>tailwind</code> block when it finds{" "}
        <code>@tailwindcss/vite</code>, and <code>spa.env</code> seeded from your Vite{" "}
        <code>define</code> block and <code>import.meta.env.VITE_*</code> usage. Add{" "}
        <code>--desktop</code> to also emit a <code>deno desktop</code> entry, and{" "}
        <code>--backend http://127.0.0.1:3773 --proxy /api,/ws</code> to wire a{" "}
        <a href="/docs/spa">backend proxy</a>:
      </p>
      <Code lang="sh">
        {`deno run -A jsr:@denext/denext/cli migrate apps/web \\
  --desktop --backend http://127.0.0.1:3773 --proxy /api,/ws`}
      </Code>
      <p>
        The same SPA path also detects a <strong>Create React App</strong> (a{" "}
        <code>react-scripts</code> dep, or a <code>public/index.html</code> with React) and a{" "}
        <strong>generic React SPA</strong> (React plus a root{" "}
        <code>index.html</code>, no Vite/CRA/Next) — seeding <code>spa.env</code> from{" "}
        <code>process.env.REACT_APP_*</code> / <code>import.meta.env.VITE_*</code>{" "}
        as appropriate. Pass <code>--from vite|cra|generic</code>{" "}
        to force the source when detection is ambiguous. (Remix is not supported.)
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
            Config moves to <code>deno.json</code>
          </strong>{" "}
          — migrate writes a <code>deno.json</code> + import map (it never touches your{" "}
          <code>package.json</code> or lockfile). The compat drop-in <em>keeps</em> your{" "}
          <code>package.json</code> and <code>node_modules</code>{" "}
          — npm React libraries load from there. Only a from-scratch native rewrite drops them
          entirely.
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
