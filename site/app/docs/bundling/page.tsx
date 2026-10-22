import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Bundling & feature flags",
  description:
    "Understand and shrink your client bundle: denext analyze (with a markdown per-module report), compile-time feature flags that dead-code-eliminate gated branches, automatic tree-shaking of sideEffects:false dependencies, and optimizePackageImports barrel rewriting.",
};

export default function Bundling() {
  return (
    <DocsShell
      active="bundling"
      title="Bundling & feature flags"
      lead="See what's in your client bundle and make it smaller: denext analyze (with a markdown per-module report), feature() flags that fold to a literal so the untaken branch is dead-code eliminated, automatic barrel tree-shaking of sideEffects:false deps, and optimizePackageImports, which rewrites barrel imports so the barrel is never loaded."
    >
      <h2>Analyze the bundle</h2>
      <p>
        <code>denext analyze</code>{" "}
        builds the app and breaks the client bundle down by chunk — sizes, proportion bars, and a
        per-role subtotal (shared runtime vs route entries vs islands), the shared-runtime line
        being the one the size budgets track. When the app has islands, a per-island breakdown
        follows: each island with what it alone loads (its own module plus the chunks only it
        reaches, listed under it), then the chunks several islands share and which islands load
        each, so a heavy library one island pulls in is told apart from one every island pays for.
      </p>
      <p>
        The tail of <code>denext analyze examples/islands</code>{" "}
        (denext 4.7, 2026-10-22; sizes vary with the version):
      </p>
      <Code lang="text">
        {`  By role:
    shared runtime     60.1 KB raw · 22.5 KB gz  (5 chunks)
    route entries      6.1 KB raw · 2.9 KB gz  (4 chunks)
    islands            2.6 KB raw · 1.3 KB gz  (3 chunks)
    on-demand runtime  29.8 KB raw · 12.3 KB gz  (8 chunks)

  By island:
    widget-5RMD7LNM.js         1.8 KB raw · 0.9 KB gz  (+1 exclusive chunk)
      chunk-IHLJ76A4.js        0.2 KB
    action-call-ESHSSAYX.js    1.1 KB raw · 0.6 KB gz  (+1 exclusive chunk)
      chunk-2V5FEKT4.js        1.0 KB raw · 0.6 KB gz
    shared between islands:
      chunk-H4S5ATD7.js        1.4 KB raw · 0.7 KB gz  action-call-ESHSSAYX.js, widget-5RMD7LNM.js`}
      </Code>
      <Code lang="bash">
        {`denext analyze            # terminal breakdown by chunk + role
denext analyze --json     # machine-readable chunk sizes
denext analyze --md > bundle-report.md   # a markdown report (CI artifact)`}
      </Code>
      <p>
        <code>--md</code>{" "}
        prints a markdown report to stdout (pipe it to a file). It carries the per-chunk table, the
        role subtotals, the per-island breakdown and a per-chunk breakdown of the modules that
        dominate each chunk, so you can see <em>which dependency</em> is fat:
      </p>
      <Code lang="markdown">
        {`### \`chunk-abc.js\`

- \`lucide-react/dist/esm/x.js\` — 18.0 KB
- \`@radix-ui/react-dialog/dist/index.mjs\` — 9.0 KB
- \`app/dashboard/page.tsx\` — 0.4 KB`}
      </Code>
      <Callout kind="note">
        The esbuild path (a <a href="/docs/migrating">drop-in compat</a> or{" "}
        <a href="/docs/spa">SPA</a>{" "}
        app on npm React) reads the module sizes from esbuild's metafile. The native{" "}
        <code>deno bundle</code> path writes none, so there <code>--md</code>{" "}
        attributes each chunk's bytes to its modules from the bundle's source maps.
      </Callout>

      <h2>Feature flags (compile-time)</h2>
      <p>
        <code>denext/feature</code>'s <code>feature("KEY")</code>{" "}
        is a build-time flag: each call whose KEY is listed in the top-level <code>features</code>
        {" "}
        of <code>denext.config.ts</code> is replaced with the literal <code>true</code> or{" "}
        <code>false</code> at build time, so the bundler <strong>dead-code-eliminates</strong>{" "}
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
  features: { NEW_CHECKOUT: false }, // flip to true to ship it
} satisfies import("denext/server").DenextConfig;`}
      </Code>
      <p>
        <code>feature()</code> <strong>always returns the configured value</strong>{" "}
        — on the server and in the browser — so dev, SSR, and the client agree. Where the build can
        prove the value (a string-literal key), it folds the call to a literal so the untaken branch
        is <strong>dead-code eliminated</strong>: the native App Router (its client modules,{" "}
        <code>.ts</code> / <code>.js</code> ones included), the SPA bundle, and dev. On the{" "}
        <strong>compat (drop-in) App Router</strong>{" "}
        path the flag is read at runtime instead, so the branch is <em>not</em>{" "}
        eliminated there. A key not listed reads <code>false</code>; a non-literal argument (<code>
          feature(name)
        </code>) is always read at runtime.
      </p>
      <Callout kind="note">
        Only a <code>feature("STRING_LITERAL")</code>{" "}
        call is folded (and dead-code-eliminated). That's the point: keep the argument a literal so
        the bundler can prove which branch to drop.
      </Callout>
      <Callout kind="warn">
        Flag <strong>names and their on/off states are embedded in the client bundle</strong> (like
        {" "}
        <code>NEXT_PUBLIC_*</code> env vars) — the gated <em>code</em>{" "}
        is dead-code eliminated when a flag is off, but the flag key itself is visible. Don't encode
        secrets or confidential roadmap names in flag keys.
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
        The array form (<code>{`"sideEffects": ["*.css", "./dist/register.js"]`}</code>) is read as
        esbuild and webpack read it: the files it names keep their side effects, every other file of
        the package is side-effect-free. A pattern with a slash matches the package-relative path;
        one without matches the file name anywhere in the package. The native{" "}
        <code>deno bundle</code> path does its own tree-shaking.
      </Callout>
      <p>
        When a package&apos;s <code>module</code>{" "}
        field names a file the package does not ship (lucide 0.564: <code>dist/esm/lucide.js</code>
        {" "}
        is missing; the ESM entry is at{" "}
        <code>dist/esm/lucide/src/lucide.js</code>), the browser bundle tries the package&apos;s
        other ESM entries before its CommonJS <code>main</code>: the next <code>exports</code>{" "}
        condition when a target is missing, the <code>jsnext:main</code> and <code>es2015</code>
        {" "}
        fields, then the same file name one or two directories below the <code>module</code>{" "}
        path. CommonJS can&apos;t be tree-shaken, so this keeps an icon library&apos;s unused icons
        out of the bundle.
      </p>
      <p>
        A bare import denext&apos;s own resolver does not place falls through to the Deno resolver,
        which reads the app&apos;s <code>package.json</code> dependencies and, with{" "}
        <code>nodeModulesDir: "manual"</code>, its{" "}
        <code>node_modules</code>. It resolves the same on Windows as on macOS and Linux: an app
        that builds on one builds on the others (through 3.4.0 a Windows build failed with{" "}
        <code>Relative import path "ms" not prefixed with / or ./ or ../</code>).
      </p>

      <h2>Barrel imports: optimizePackageImports</h2>
      <p>
        Tree-shaking drops unused exports, but the bundler still <em>loads</em>{" "}
        the barrel and every module it re-exports. <code>optimizePackageImports</code>{" "}
        (Next.js's key, top-level in <code>denext.config.ts</code>) rewrites{" "}
        <code>{`import { Check } from "lucide-react"`}</code>{" "}
        to an import of the module that defines{" "}
        <code>Check</code>, so the barrel never enters the module graph — and when a package also
        code-splits every export (lucide's{" "}
        <code>dynamicIconImports</code>), none of those chunks land in your startup chunk list. A
        built-in list is on by default (<code>lucide-react</code>, <code>date-fns</code>,{" "}
        <code>lodash-es</code>, <code>react-icons/*</code>, <code>@mui/icons-material</code>,{" "}
        <code>recharts</code>, …); your entries are added to it.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  optimizePackageImports: ["@acme/icons", "!recharts"], // add one, exclude a default
  // optimizePackageImports: false,                      // or turn it off entirely
} satisfies import("denext/server").DenextConfig;`}
      </Code>
      <Callout kind="warn">
        Listing a package asserts its modules are <strong>side-effect free</strong>{" "}
        (Next.js's contract too): a top-level side effect in a module you don't import no longer
        runs. A barrel that runs code of its own (a call, a decorator, a directive) is detected and
        left alone.
      </Callout>
      <h3>Automatic barrels</h3>
      <p>
        A package that declares itself side-effect-free (<code>"sideEffects": false</code>, or an
        array that names none of the modules its barrel loads) gets the same rewrite without being
        listed. Besides the module-graph savings, that fixes a code-splitting effect: when the
        startup graph and a lazily loaded route import different names from one barrel, esbuild
        places every module the barrel re-exports in a chunk the startup graph loads, the lazy
        route&apos;s modules included. Rewritten imports keep each module with the code that uses it
        (a large real-world app with its list removed: boot JS 1.53 MB → 1.24 MB gzip with the
        ESM-entry fix above, the same bytes as with the list).
      </p>
      <p>
        The automatic path is narrower than a listed package: the barrel must be the file the build
        itself resolves the specifier to (an alias, or the denext runtime owning a name, rules it
        out); a name the barrel re-exports from another package stays on the barrel import; and
        every module the barrel would have loaded must be side-effect-free by its package&apos;s own
        declaration. <code>"!pkg"</code> excludes a package, and <code>"!*"</code>{" "}
        turns the automatic mode off (listed packages are still rewritten).
      </p>
      <Callout kind="note">
        The rewrite runs in the esbuild bundles (compat client/server and SPA, production builds and
        compat dev rebuilds). The unbundled per-module dev server and the native{" "}
        <code>deno bundle</code> path don't apply it. See{" "}
        <a href="/docs/config#build--optimization">the config reference</a>.
      </Callout>
    </DocsShell>
  );
}
