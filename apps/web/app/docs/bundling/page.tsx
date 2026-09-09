import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Bundling & feature flags",
  description:
    "Understand and shrink your client bundle: denext analyze (with a markdown per-module report), compile-time feature flags that dead-code-eliminate gated branches, and automatic tree-shaking of sideEffects:false dependencies.",
};

export default function Bundling() {
  return (
    <DocsShell
      active="bundling"
      title="Bundling & feature flags"
      lead="See what's in your client bundle and make it smaller: denext analyze (with a markdown per-module report), feature() flags that fold to a literal so the untaken branch is dead-code eliminated, and automatic barrel tree-shaking of sideEffects:false deps."
    >
      <h2>Analyze the bundle</h2>
      <p>
        <code>denext analyze</code>{" "}
        builds the app and breaks the client bundle down by chunk — sizes, proportion bars, and a
        per-role subtotal (shared runtime vs route entries vs islands), the shared-runtime line
        being the one the size budgets track.
      </p>
      <Code lang="bash">
        {`denext analyze            # terminal breakdown by chunk + role
denext analyze --json     # machine-readable chunk sizes
denext analyze --md > bundle-report.md   # a markdown report (CI artifact)`}
      </Code>
      <p>
        <code>--md</code>{" "}
        prints a markdown report to stdout (pipe it to a file). It carries the per-chunk table and
        role subtotals on every project, and — on the esbuild path (a{" "}
        <a href="/docs/migrating">drop-in compat</a> or <a href="/docs/spa">SPA</a>{" "}
        app) — a per-chunk breakdown of the modules that dominate each chunk, so you can see{" "}
        <em>which dependency</em> is fat:
      </p>
      <Code lang="markdown">
        {`### \`chunk-abc.js\`

- \`lucide-react/dist/esm/x.js\` — 18.0 KB
- \`@radix-ui/react-dialog/dist/index.mjs\` — 9.0 KB
- \`app/dashboard/page.tsx\` — 0.4 KB`}
      </Code>
      <Callout kind="note">
        The native App Router path bundles with{" "}
        <code>deno bundle</code>, which emits no module-level metafile, so <code>--md</code>{" "}
        stays chunk-level there. The per-module section appears for the esbuild compat/SPA path.
      </Callout>

      <h2>Feature flags (compile-time)</h2>
      <p>
        <code>denext/feature</code>'s <code>feature("KEY")</code>{" "}
        is a build-time flag: each call whose KEY is listed in <code>experimental.features</code>
        {" "}
        is replaced with the literal <code>true</code> or <code>false</code>{" "}
        at build time, so the bundler <strong>dead-code-eliminates</strong>{" "}
        the untaken branch — the gated code, and anything only it imports, costs{" "}
        <strong>zero bytes</strong> when the flag is off.
      </p>
      <Code lang="tsx">
        {`import { feature } from "denext/feature";

export function Checkout() {
  if (feature("NEW_CHECKOUT")) {
    return <NewCheckout />; // dropped from the bundle when the flag is off
  }
  return <LegacyCheckout />;
}`}
      </Code>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  experimental: {
    features: { NEW_CHECKOUT: false }, // flip to true to ship it
  },
} satisfies import("denext/server").DenextConfig;`}
      </Code>
      <p>
        The fold runs on <strong>every path</strong>{" "}
        — the native App Router bundle, the compat/SPA esbuild bundle, and the dev server — so what
        you see in dev matches the build. A key not listed in <code>experimental.features</code>
        {" "}
        reads <code>false</code>; a call with a non-literal argument (<code>
          feature(name)
        </code>) can't be folded and reads the seeded value at runtime. Server rendering reads the
        same map.
      </p>
      <Callout kind="note">
        Only a <code>feature("STRING_LITERAL")</code>{" "}
        call is folded (and dead-code-eliminated). That's the point: keep the argument a literal so
        the bundler can prove which branch to drop.
      </Callout>

      <h2>Tree-shaking sideEffects:false deps</h2>
      <p>
        On the esbuild path, denext reads each dependency's <code>package.json</code>{" "}
        and, when it declares{" "}
        <code>"sideEffects": false</code>, tells the bundler the package is side-effect-free — so
        importing one export from a barrel <code>index</code> (a <code>lucide-react</code> icon, one
        {" "}
        <code>@radix-ui</code>{" "}
        primitive) no longer drags in the whole package. This is automatic; there's nothing to
        configure.
      </p>
      <Callout kind="note">
        Only the boolean <code>"sideEffects": false</code>{" "}
        form is honored; the array form is treated conservatively as having side effects (never
        wrongly dropped). The native <code>deno bundle</code> path does its own tree-shaking.
      </Callout>
    </DocsShell>
  );
}
