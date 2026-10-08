import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Islands & hydration",
  description:
    'Turn any "use client" component into an island that hydrates on its own schedule — client:load | idle | visible | interaction | media | only. Full Astro-style directive parity, on React.',
};

export default function Islands() {
  return (
    <DocsShell
      active="islands"
      title="Islands & hydration"
      lead="A client:* directive turns a 'use client' component into an island: it hydrates on its own schedule instead of eagerly with the page. Each island stays inert server-rendered HTML until its strategy fires — a real IntersectionObserver, requestIdleCallback, or matchMedia — so an interaction island can ship zero JavaScript until you actually touch it. denext has full 6/6 Astro-style directive parity, on React's own 'use client' model — plus resumability Astro lacks."
    >
      <h2>What an island is</h2>
      <p>
        By default a page with any interactivity hydrates as one tree: on load the client re-runs
        every component to attach handlers, whether or not the visitor uses them. An{" "}
        <strong>island</strong> opts one <code>"use client"</code>{" "}
        subtree out of that: it is left as inert server DOM and gets its own scoped hydration only
        when its trigger fires. You mark one with a <code>client:*</code>{" "}
        directive at the usage site:
      </p>
      <Code lang="tsx">
        {`import Chart from "./Chart.tsx"; // a "use client" component

export default function Page() {
  return (
    <main>
      <Chart client:visible /> {/* hydrate when it scrolls into view */}
    </main>
  );
}`}
      </Code>
      <Callout kind="note">
        Directives are <strong>opt-in and tree-shaken</strong>: a component with no{" "}
        <code>client:*</code>{" "}
        directive hydrates normally (eagerly), and an app that uses no islands bundles none of the
        lazy-hydration runtime. Islands are the fine-grained-hydration half of{" "}
        <a href="/docs/resumability">resumability</a> — in a <code>resumable</code>{" "}
        route islands wake automatically and you only add a directive to override.
      </Callout>

      <h2>The six directives</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Directive</th>
              <th>Hydrates when…</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>client:load</code>
              </td>
              <td>
                Immediately — but per-island (its own scoped hydration, not the whole tree).
              </td>
            </tr>
            <tr>
              <td>
                <code>client:idle</code>
              </td>
              <td>
                The main thread goes idle (<code>requestIdleCallback</code>, with a timeout
                fallback).
              </td>
            </tr>
            <tr>
              <td>
                <code>client:visible</code>
              </td>
              <td>
                The island scrolls into view (<code>IntersectionObserver</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>client:interaction</code>
              </td>
              <td>
                The first interaction inside it — a delegated listener catches the event, hydrates
                the island, and <em>replays</em>{" "}
                the event so the real handler fires. May never hydrate.
              </td>
            </tr>
            <tr>
              <td>
                <code>client:media="(min-width:800px)"</code>
              </td>
              <td>
                A CSS media query matches (<code>matchMedia</code>); re-checked as the query
                changes.
              </td>
            </tr>
            <tr>
              <td>
                <code>client:only</code>
              </td>
              <td>
                Client-only —{" "}
                <strong>no SSR</strong>. The server renders no HTML for it; the client mounts it
                fresh (<code>createRoot</code>, not hydrate).
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Examples</h2>
      <Code lang="tsx">
        {`<Comments   client:idle />                       {/* defer below-the-fold work */}
<Gallery    client:visible />                    {/* hydrate on scroll */}
<Search     client:interaction />                {/* pay only if the user opens it */}
<Sidebar    client:media="(min-width: 900px)" /> {/* only hydrate on wide viewports */}
<Editor     client:only />                       {/* browser-only widget, no SSR pass */}`}
      </Code>

      <Callout kind="warn">
        <strong>
          <code>client:only</code> renders nothing on the server
        </strong>{" "}
        — there is no first paint for that subtree until the client mounts it, and its content is
        invisible to crawlers. Use it for genuinely browser-only widgets (a canvas, a map, something
        that touches <code>window</code>{" "}
        at import); prefer an SSR-able directive when the content matters for SEO or layout
        stability. In development, denext <strong>warns</strong>{" "}
        when it spots SEO-relevant content (a heading or paragraph) passed into a{" "}
        <code>client:only</code> island, so this mistake surfaces before it ships.
      </Callout>

      <h2>A per-component default</h2>
      <p>
        A component can name its own baseline strategy by exporting <code>hydrate</code>{" "}
        from its module — handy when a widget almost always wants the same wake moment. Precedence
        is <strong>usage-site prop &gt; module default &gt; eager</strong>: a <code>client:*</code>
        {" "}
        at the call site always wins.
      </p>
      <Code lang="tsx">
        {`// Chart.tsx
"use client";
export const hydrate = "visible"; // default: hydrate on scroll

export default function Chart() { /* … */ }

// Page.tsx
<Chart />                 {/* uses the module default → client:visible */}
<Chart client:load />     {/* overridden at the call site → immediate */}`}
      </Code>

      <h2>What ends up in the DOM</h2>
      <p>
        Nothing exotic — an island is a layout-neutral wrapper carrying its strategy, adopted (but
        not executed) by the page root until it wakes:
      </p>
      <Code lang="html">
        {`<div data-dnx-island data-dnx-id="0.3" data-dnx-strategy="visible"
     style="display:contents">
  <div class="chart">…server-rendered island HTML…</div>
</div>`}
      </Code>
      <p>
        The <code>display:contents</code> wrapper adds no box, so it never affects layout. See{" "}
        <a href="/docs/resumability">Resumability</a> for how state (<code>useSignal</code>/
        <code>useStore</code>) and code-split handlers (<code>qrl</code>) ride along.
      </p>

      <h2>Nested islands defer independently</h2>
      <Callout kind="note">
        <strong>
          A <code>client:*</code>{" "}
          directive works anywhere — including on an island nested inside another island.
        </strong>{" "}
        The inner island carves its own wrapper and hydrates on <em>its own</em>{" "}
        strategy, not its parent's: a <code>client:visible</code> island inside a{" "}
        <code>client:idle</code>{" "}
        one waits until it scrolls into view even though the parent woke on idle. Each island's
        server HTML stays inert until its own strategy fires, and the enclosing island adopts the
        nested one's DOM without re-hydrating it.
      </Callout>
      <h2>In SPA mode: deferred mounts</h2>
      <p>
        A <a href="/docs/spa">SPA</a>{" "}
        has no server render, so there is no HTML to keep inert. The same directives there defer the
        component's <em>mount</em>, and its code: the build rewrites each <code>client:*</code>{" "}
        element of the app's own modules, and when those elements are a component's only use, its
        module becomes a chunk of its own, fetched when the trigger fires. Until then the element
        renders its <code>client:placeholder</code> (or an empty element).
      </p>
      <Code lang="tsx">
        {`import Mermaid from "./Mermaid.tsx";
import { DiffPanel } from "./DiffPanel.tsx";

export function Thread({ diagram, diff }) {
  return (
    <>
      <Mermaid client:visible source={diagram} />
      <DiffPanel
        client:interaction
        client:placeholder={<button type="button">Show the diff</button>}
        diff={diff}
      />
    </>
  );
}`}
      </Code>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Directive</th>
              <th>In a SPA the component mounts when…</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>client:load</code>, <code>client:only</code>
              </td>
              <td>Immediately (its chunk still loads on its own).</td>
            </tr>
            <tr>
              <td>
                <code>client:idle</code>
              </td>
              <td>The main thread is idle.</td>
            </tr>
            <tr>
              <td>
                <code>client:visible</code>
              </td>
              <td>The placeholder comes within 200px of the viewport.</td>
            </tr>
            <tr>
              <td>
                <code>client:media="(…)"</code>
              </td>
              <td>The media query matches.</td>
            </tr>
            <tr>
              <td>
                <code>client:interaction</code>
              </td>
              <td>
                The first pointer, key, focus or touch event inside the placeholder (give it a{" "}
                <code>client:placeholder</code>{" "}
                to interact with). The triggering event is not replayed: the placeholder is not the
                component's DOM.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The component gets the element's other props and children, and later renders update it as
        usual. A failed chunk import throws to the nearest error boundary. Only a component imported
        by name (default or named) is deferred; a member tag (<code>
          &lt;UI.Chart client:visible /&gt;
        </code>), a module-level <code>export const hydrate</code>{" "}
        default and an element whose name an inner scope re-binds mount eagerly. A component that is
        also used without a directive, or referenced as a value, keeps its static import: its
        directive elements still defer their mount, but its code stays in the main bundle. An app
        with no directive bundles none of this. In an npm-React app type-checked against{" "}
        <code>@types/react</code>, TypeScript learns the attributes from{" "}
        <code>denext/jsx-directives</code>'s <code>ClientDirectives</code>, added to React's{" "}
        <code>Attributes</code> by a two-line declaration of your own (with{" "}
        <code>deno check</code>, list it in <code>compilerOptions.types</code>):
      </p>
      <Code lang="ts">
        {`// client-directives.d.ts
import type { ClientDirectives } from "denext/jsx-directives";
declare module "react" { interface Attributes extends ClientDirectives<import("react").ReactNode> {} }`}
      </Code>
      <p>
        Islands are a <a href="/docs/rendering">rendering-strategy</a>{" "}
        feature of the client/server (Flight) boundary — any App Router app with a{" "}
        <code>"use client"</code> component. See <a href="/docs/rendering">Rendering strategies</a>
        {" "}
        for how islands sit alongside streaming, PPR, and the other strategies, and{" "}
        <a href="/docs/resumability">Resumability</a> for zero-up-front-hydration routes.
      </p>
    </DocsShell>
  );
}
