import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "React Router",
  description:
    "@denext/react-router runs a React Router v7 framework-mode app on denext as a plugin, with the app's source unchanged.",
};

export default function ReactRouterDocs() {
  return (
    <DocsShell
      active="react-router"
      title="React Router"
      lead="@denext/react-router runs a React Router v7 framework-mode app on denext — config routing in app/routes.ts, loaders and actions, the root shell — with your source unchanged. denext migrate wires it for you."
    >
      <h2>Setup</h2>
      <p>
        <code>denext migrate</code> detects a React Router v7 app (an{" "}
        <code>app/routes.ts</code>) and writes the config; to add it by hand:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import { reactRouter } from "@denext/react-router";
export default { plugins: [reactRouter()] };`}
      </Code>

      <h2>How it works</h2>
      <p>
        React Router v7's framework mode is Remix's successor: routes are declared in{" "}
        <code>app/routes.ts</code> with <code>route()</code> / <code>index()</code> /{" "}
        <code>layout()</code> / <code>prefix()</code>, each route module exports a{" "}
        <code>loader</code>/<code>action</code> and a component, and <code>app/root.tsx</code>{" "}
        is the document shell. The plugin runs such an app on denext without touching its source:
      </p>
      <ul>
        <li>
          It evaluates <code>app/routes.ts</code> (the config DSL, imported from{" "}
          <code>@react-router/dev/routes</code> — aliased to{" "}
          <code>@denext/react-router/routes</code>).
        </li>
        <li>
          It generates a denext route module for each route under{" "}
          <code>.denext/react-router/</code>: the <code>"use client"</code>{" "}
          component split from its server <code>loader</code>/<code>action</code>{" "}
          data module, wrapped for the <code>denext/remix</code> runtime.
        </li>
        <li>
          It adds those routes through denext's <strong>route-synthesizer</strong>{" "}
          plugin seam, so Flight, streaming SSR, per-segment error boundaries, soft navigation, ISR
          and Fast Refresh are denext's own.
        </li>
      </ul>
      <p>
        Loaders and actions, <code>meta</code>, <code>links</code>, <code>ErrorBoundary</code> (with
        {" "}
        <code>useRouteError</code>/<code>isRouteErrorResponse</code>), the root <code>Layout</code>
        {" "}
        export, and the <code>Route.ComponentProps</code>{" "}
        props contract (<code>loaderData</code>/<code>actionData</code>/<code>params</code>/
        <code>matches</code>{" "}
        as component props) all work — the framework API is Remix's, which denext already
        implements.
      </p>

      <Callout kind="note">
        Commit{" "}
        <code>.denext/react-router/</code>? No — it is generated on every build and dev scan (and
        gitignored with the rest of <code>.denext/</code>). Your <code>app/</code>{" "}
        files are the source of truth.
      </Callout>

      <h2>Limitations</h2>
      <ul>
        <li>
          <strong>Server rendering only.</strong> <code>clientLoader</code>,{" "}
          <code>clientAction</code> and <code>HydrateFallback</code>{" "}
          are not run — loaders and actions run on the server.
        </li>
        <li>
          <code>react-router.config.ts</code> <code>ssr: false</code>{" "}
          (RR's SPA mode) is not this plugin — use denext's <code>mode: "spa"</code>{" "}
          for a pure client app; <code>prerender</code>{" "}
          is not applied (denext prerenders static routes itself).
        </li>
        <li>
          Route typegen (<code>import type &#123; Route &#125; from "./+types/…"</code>) is
          type-only and erases at runtime, so the app runs without it.
        </li>
      </ul>
    </DocsShell>
  );
}
