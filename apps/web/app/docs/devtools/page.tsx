import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "DevTools",
  description:
    "A first-party in-page glass-box panel at React-DevTools quality — element picker, tree, live hooks/props editing, a Profiler flamegraph, and a real-time boundary waterfall — plus stock React DevTools support.",
};

export default function DevTools() {
  return (
    <DocsShell
      active="devtools"
      title="DevTools"
      lead="denext ships its own in-page glass-box panel — element picker, searchable tree, live hooks/state and prop editing, a per-commit Profiler flamegraph, and a real-time streaming-boundary waterfall — and also lights up the stock React DevTools extension."
    >
      <p>
        In dev, denext auto-mounts a first-party DevTools panel. There is nothing to install: a
        small launcher (the denext mascot) sits at the bottom-left of every dev page, and{" "}
        <code>Ctrl+Shift+D</code>{" "}
        toggles the panel. It reads everything from the live reconciler through a typed API and
        renders with plain DOM in its own update loop, so inspecting never re-enters the tree it
        inspects. It is <strong>dev-only</strong>{" "}
        and tree-shaken entirely out of production bundles.
      </p>

      <Callout kind="note">
        The panel is styled with inline CSS (CSSOM), never a <code>{"<style>"}</code>{" "}
        sheet, so it works unchanged under denext's strict <code>style-src 'self'</code>{" "}
        dev CSP. Its image launcher is an inlined data URI (allowed by the default{" "}
        <code>img-src 'self' data:</code>).
      </Callout>

      <h2>Components</h2>
      <p>
        The Components tab is a live tree of your app. It updates on every commit, coalesced to a
        frame.
      </p>
      <ul>
        <li>
          <strong>Element picker</strong> — click <code>🎯</code>{" "}
          then hover the page: the hovered element's owning component is highlighted with an overlay
          and a name tooltip; click to select it. Hovering a tree row reverse- highlights its DOM
          node.
        </li>
        <li>
          <strong>Searchable, collapsible tree</strong>{" "}
          — filter rows by component name (ancestors of matches are kept), collapse/expand any
          subtree, and toggle <code>{"{ }"}</code> to show host (DOM) nodes alongside components.
        </li>
        <li>
          <strong>Badges</strong> — <code>memo</code>, <code>forwardRef</code>,{" "}
          <code>StrictMode</code>, <code>Suspense</code> (+<code>fallback</code>),{" "}
          <code>ErrorBoundary</code> (+<code>errored</code>), <code>Context.Provider</code>.
        </li>
        <li>
          <strong>Live editing</strong>{" "}
          — edit a state value in place, dispatch a reducer action, set a ref's{" "}
          <code>current</code>, or pin a prop with a live override (and reset it). Effect hooks show
          their <code>deps</code> and whether they hold a cleanup.
        </li>
        <li>
          <strong>Deep value inspection</strong>{" "}
          — expand nested objects/arrays on demand (lazily read from the live value), and per value:
          {" "}
          <em>copy</em>, <em>log</em> to the console (the real value, not a preview), or stash it as
          {" "}
          <code>window.$d</code>.
        </li>
        <li>
          <strong>Why did this render?</strong>{" "}
          — after a commit, the props, hooks, and contexts that changed are marked in the accent
          color, with a render count.
        </li>
        <li>
          <strong>Source &amp; owner stack</strong> — a <code>vscode://file</code>{" "}
          link to the component's source and its render-parent chain.
        </li>
      </ul>

      <h2>Profiler</h2>
      <p>
        Click <strong>Record</strong>, interact, then{" "}
        <strong>Stop</strong>. The Profiler captures every commit:
      </p>
      <ul>
        <li>
          A <strong>commit-bar strip</strong>{" "}
          (one bar per commit, height ∝ its total render time) you can click to step through.
        </li>
        <li>
          A <strong>flamegraph</strong>{" "}
          for the selected commit — width ∝ total time under each component, a warm fill ∝ its own
          render time, and components that didn't render dimmed. Click a bar to jump to that
          component in the tree.
        </li>
        <li>
          A <strong>ranked-by-self chart</strong> with{" "}
          <em>why each rendered</em>, so the most expensive components in that commit — and the
          reason they ran — are one glance away.
        </li>
      </ul>

      <h2>Render modes</h2>
      <p>The glass-box view of how the page reached the browser:</p>
      <ul>
        <li>
          <strong>Page verdict</strong>{" "}
          — static vs dynamic vs streamed, and the page-cache outcome (<code>
            HIT
          </code>/<code>
            STALE
          </code>/<code>MISS</code>).
        </li>
        <li>
          <strong>Live Suspense-boundary waterfall</strong>{" "}
          — each streamed boundary appears the instant it lands, showing its server-resolve time and
          the moment it was revealed on the client. The swap runtime records these reveals in real
          time (without varying its CSP-hashed script), so the timeline fills as holes stream in —
          not only once the stream ends.
        </li>
        <li>
          <strong>Island hydration</strong> — which islands hydrated, under which{" "}
          <code>client:*</code> strategy, and when.
        </li>
      </ul>

      <h2>Stock React DevTools</h2>
      <p>
        If you have the React DevTools browser extension installed, denext lights it up too: it
        registers as a renderer and reports a React-fiber-shaped tree, so the{" "}
        <strong>Components</strong>{" "}
        panel shows your tree and props, and — routed back through denext's reconciler —{" "}
        <strong>live prop/state editing</strong> and <strong>element selection</strong> work.
      </p>
      <Callout kind="warn">
        The extension's <em>hooks view</em> and its <em>Profiler</em>{" "}
        rely on React-internal introspection that a non-React fiber tree can't provide. Use denext's
        own panel for hooks/state fidelity and profiling — it is the full-fidelity surface.
      </Callout>

      <h2>Programmatic API</h2>
      <p>
        The same surface is available as a module and on <code>window.__denextDevtools</code>{" "}
        in dev, for editor integrations, tests, or custom tooling.
      </p>
      <Code lang="ts">
        {`import { installInspector } from "denext/devtools";

const dt = installInspector(); // null in production / before dev is active
if (dt) {
  const tree = dt.getInspectorTree();          // component tree (props, hooks, context, badges)
  dt.setHookState(fiberId, hookIndex, next);   // live-edit a useState cell
  dt.setPropOverride(fiberId, "title", "hi");  // pin a prop
  dt.enableRenderReasons();                     // then dt.getRenderReason(fiberId)
  dt.startProfiling();                          // then dt.getCommits() / dt.getCommitTree(i)
  dt.getBoundaryTimings();                       // live Suspense-boundary waterfall data
}`}
      </Code>
      <p>
        <code>installDevtools()</code>{" "}
        (which mounts the panel) is called automatically by the dev route entries; you only need
        {" "}
        <code>installInspector()</code> to read the data yourself.
      </p>
    </DocsShell>
  );
}
