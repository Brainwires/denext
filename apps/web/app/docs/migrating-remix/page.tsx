import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Migrating from Remix",
  description:
    "denext migrate converts a Remix (or React Router v7 framework-mode) app to denext conventions and keeps its loaders, actions, and hooks running on the denext/remix runtime.",
};

export default function MigratingRemix() {
  return (
    <DocsShell
      active="migrating-remix"
      title="Migrating from Remix"
      lead="denext migrate converts a Remix (or React Router v7 framework-mode) app to denext conventions and keeps its loaders, actions, and hooks running on the denext/remix runtime. Your data model stays as it is; the route tree moves."
    >
      <h2>The command</h2>
      <p>
        Run the migration tool in the Remix project. It detects a Remix app on its own (from{" "}
        <code>@remix-run/*</code> deps, a <code>remix.config.*</code>, a React Router v7{" "}
        <code>react-router.config.*</code>, or the <code>app/root.tsx</code> +{" "}
        <code>app/routes/</code> layout); pass <code>--from remix</code>{" "}
        to force it when detection is ambiguous.
      </p>
      <Code lang="sh">
        {`deno run -A jsr:@denext/denext/cli migrate --from remix
deno task dev`}
      </Code>
      <p>
        Unlike the{" "}
        <a href="/docs/migrating">Next.js path</a>, which only writes config, the Remix path{" "}
        <strong>physically transforms your route tree</strong>. It writes the usual{" "}
        <code>deno.json</code> (with <code>denext/remix</code> and <code>denext/remix/server</code>
        {" "}
        in the import map, and <code>@remix-run/*</code> / <code>@react-router/*</code>{" "}
        dropped from the pinned npm deps), a compat <code>denext.config.ts</code>, and a{" "}
        <code>.gitignore</code>; then it rewrites <code>app/</code>{" "}
        in place. Commit first so the transform is easy to diff and review.
      </p>
      <Callout kind="note">
        Migrating a project that already has <code>node_modules</code>{" "}
        installed (most real apps)? Add <code>--node-modules-dir=none</code> to the migrate command:
        {" "}
        <code>
          deno run --node-modules-dir=none -A jsr:@denext/denext/cli migrate --from remix
        </code>. Without it, Deno runs in manual-<code>node_modules</code>{" "}
        mode and can't resolve the CLI's own build dependencies. Yarn Plug'n'Play installs are not
        supported: denext resolves your app's <code>node_modules</code> on disk, so set{" "}
        <code>nodeLinker: node-modules</code> in <code>.yarnrc.yml</code>{" "}
        and reinstall before migrating.
      </Callout>

      <h2>How routes convert</h2>
      <p>
        Every module under <code>app/routes/</code>{" "}
        (flat files, dot-nested names, and the v2 folder form with a{" "}
        <code>route.tsx</code>) is relocated to a denext folder per segment: <code>$param</code>
        {" "}
        becomes <code>[param]</code>, a bare <code>$</code> becomes <code>[...splat]</code>,{" "}
        <code>_index</code> becomes the segment's <code>page.tsx</code>, a pathless{" "}
        <code>_auth.login</code> becomes the <code>(auth)/login</code> route group, and a{" "}
        <code>[.]</code> escape (as in{" "}
        <code>sitemap[.]xml</code>) is unescaped. A route that other routes nest under becomes that
        segment's <code>layout.tsx</code>.
      </p>
      <p>
        A Remix route module holds a server <code>loader</code>{" "}
        and a client component in one file, and a <code>"use client"</code>{" "}
        module cannot do both. So each route is{" "}
        <strong>split into three files</strong>: a client component (<code>
          page.client.tsx
        </code>), a server data module (<code>page.data.ts</code> with the <code>loader</code>,{" "}
        <code>action</code>, <code>meta</code>, <code>links</code>, <code>headers</code>,{" "}
        <code>handle</code>, and <code>shouldRevalidate</code>), and a generated{" "}
        <code>page.tsx</code>{" "}
        wrapper that runs the loader on the server and hands its data to the component. Helpers and
        imports are copied only into the split that references them. The wrapper keeps the
        Remix-canonical route id (<code>
          routes/concerts.$city
        </code>), so <code>useMatches</code> and <code>useRouteLoaderData("root")</code>{" "}
        still find it.
      </p>
      <Code lang="tsx">
        {`// Before: app/routes/concerts.$city.tsx
import { json } from "@remix-run/node";
import { useLoaderData, useParams } from "@remix-run/react";

export function loader() {
  return json({ soldOut: false });
}

export default function City() {
  const { city } = useParams();
  const data = useLoaderData<typeof loader>();
  return <h2>{city}: {data.soldOut ? "sold out" : "available"}</h2>;
}`}
      </Code>
      <Code lang="tsx">
        {`// After: app/concerts/[city]/page.data.ts (server)
import { json } from "denext/remix/server";

export function loader() {
  return json({ soldOut: false });
}

// After: app/concerts/[city]/page.client.tsx (client)
"use client";
import { useLoaderData, useParams } from "denext/remix";
import type { loader } from "./page.data.ts";
import { RemixRouteProvider } from "denext/remix";

function City() {
  const { city } = useParams();
  const data = useLoaderData<typeof loader>();
  return <h2>{city}: {data.soldOut ? "sold out" : "available"}</h2>;
}

// ...plus a generated default export that wraps <City /> in
// <RemixRouteProvider> and receives the loader data as a prop.

// After: app/concerts/[city]/page.tsx (generated server wrapper)
import Route from "./page.client.tsx";
import * as data from "./page.data.ts";
import { RemixRoute } from "denext/remix/server";

export default function Page(props: { params: Record<string, string> }) {
  return RemixRoute({
    id: "routes/concerts.$city",
    loader: data.loader,
    Route,
    params: props.params,
  });
}`}
      </Code>
      <p>
        A page route with an <code>action</code> also gets a <code>route.ts</code> with a{" "}
        <code>POST</code>{" "}
        handler, so a plain POST to the page URL runs the action, exactly the Remix model. That is
        what keeps a cross-route <code>fetcher.submit</code> or <code>&lt;Form action&gt;</code>
        {" "}
        and the no-JS form post working. A <strong>resource route</strong>{" "}
        (a loader or action with no component) becomes a denext API <code>route.ts</code> with{" "}
        <code>GET</code> and/or <code>POST</code>. A route with an <code>ErrorBoundary</code>{" "}
        gets an <code>error.tsx</code> that renders it.
      </p>
      <p>
        <code>app/root.tsx</code> becomes <code>app/layout.tsx</code>: <code>&lt;Meta /&gt;</code>,
        {" "}
        <code>&lt;Links /&gt;</code>, <code>&lt;Scripts /&gt;</code>,{" "}
        <code>&lt;ScrollRestoration /&gt;</code>, and <code>&lt;LiveReload /&gt;</code>{" "}
        are stripped (denext owns the document), <code>&lt;Outlet /&gt;</code> becomes{" "}
        <code>{"{children}"}</code>, and a <code>meta</code> export is bridged to{" "}
        <code>generateMetadata</code>. A pure document-shell root becomes a plain server layout; a
        root that uses hooks, event handlers, or a loader goes through the same client/data split as
        a route. <code>entry.server.*</code> and <code>entry.client.*</code> are deleted, and{" "}
        <code>@remix-run/*</code> imports in shared modules outside <code>routes/</code>{" "}
        (sessions, utils, components) are rewritten too.
      </p>

      <h2>The import map</h2>
      <p>
        Import specifiers are remapped mechanically, in routes and in the rest of{" "}
        <code>app/</code>. Nothing else about the import changes; the named exports keep their Remix
        names.
      </p>
      <ul>
        <li>
          <code>@remix-run/react</code> becomes <code>denext/remix</code> (hooks, <code>Link</code>,
          {" "}
          <code>NavLink</code>, <code>Form</code>, <code>Outlet</code>,{" "}
          <code>Await</code>, and the rest of the client surface).
        </li>
        <li>
          <code>@remix-run/node</code>, <code>@remix-run/cloudflare</code>,{" "}
          <code>@remix-run/deno</code>, and <code>@remix-run/server-runtime</code> become{" "}
          <code>denext/remix/server</code> (<code>json</code>, <code>redirect</code>,{" "}
          <code>data</code>,{" "}
          <code>defer</code>, cookies, session storage, multipart upload helpers).
        </li>
        <li>
          <code>@remix-run/css-bundle</code> becomes <code>denext/remix/server</code>, where{" "}
          <code>cssBundleHref</code> is <code>undefined</code> (denext handles CSS itself; see{" "}
          <a href="/docs/styling">Styling</a>).
        </li>
        <li>
          <code>react-router</code> and <code>react-router-dom</code> become{" "}
          <code>denext/remix</code>, which covers React Router v7 framework-mode apps.
        </li>
      </ul>

      <h2>What carries over</h2>
      <ul>
        <li>
          <strong>Loaders and actions</strong> run on the server, unchanged. <code>json</code>,{" "}
          <code>redirect</code>, <code>replace</code>, <code>data</code>, and thrown{" "}
          <code>Response</code>s behave as in Remix.
        </li>
        <li>
          <strong>
            <code>&lt;Form&gt;</code> and <code>useSubmit</code>
          </strong>{" "}
          are backed by denext Server Actions, so a submit runs the route's <code>action</code> and
          {" "}
          <code>useActionData</code>{" "}
          sees the result. Progressive enhancement holds: the form posts without JavaScript.
        </li>
        <li>
          <strong>Data and navigation hooks</strong>: <code>useLoaderData</code>,{" "}
          <code>useRouteLoaderData</code>, <code>useMatches</code>, <code>useParams</code>,{" "}
          <code>useLocation</code>, <code>useNavigate</code>, <code>useSearchParams</code>,{" "}
          <code>useNavigation</code>, <code>useRevalidator</code>, <code>useFetcher</code>,{" "}
          <code>useFetchers</code>, and <code>useBlocker</code>.
        </li>
        <li>
          <strong>Sessions and cookies</strong>: <code>createCookie</code>,{" "}
          <code>createCookieSessionStorage</code>, <code>createMemorySessionStorage</code>, and{" "}
          <code>createSessionStorage</code> from <code>denext/remix/server</code>.
        </li>
        <li>
          <strong>
            <code>defer</code> and <code>&lt;Await&gt;</code>
          </strong>: the shell paints immediately with the <code>Await</code>{" "}
          fallback and the deferred content streams in as it resolves; a rejection drives{" "}
          <code>errorElement</code> via <code>useAsyncError</code>.
        </li>
        <li>
          <strong>Nested routes and layouts</strong>: <code>&lt;Outlet /&gt;</code>{" "}
          in a layout route renders the nested subtree, <code>useOutletContext</code> works, and
          {" "}
          <code>ErrorBoundary</code> (with <code>useRouteError</code> and{" "}
          <code>isRouteErrorResponse</code>) maps to an <code>error.tsx</code>.
        </li>
      </ul>

      <h2>What to review after</h2>
      <p>
        The transform is assisted, not silent. The CLI prints a report (routes converted, loaders
        and actions wired, files removed) followed by <strong>review notes</strong>{" "}
        for anything it could not map one-to-one. Read those before you run the app.
      </p>
      <Callout kind="warn">
        Structural edges are flagged rather than guessed at: a trailing-underscore{" "}
        <strong>layout break-out</strong> (<code>dashboard_.settings</code>) is flattened to{" "}
        <code>dashboard/settings</code> and its nesting change noted; a Remix v1{" "}
        <code>CatchBoundary</code> still renders via <code>useCatch</code>{" "}
        but you should fold it into a v2 <code>ErrorBoundary</code>; a layout route with no{" "}
        <code>&lt;Outlet /&gt;</code> is reported because its nested routes will not show; a root
        {" "}
        <code>meta</code> or <code>links</code> export is ported but worth a look at the rendered
        {" "}
        <code>&lt;head&gt;</code>.
      </Callout>
      <ul>
        <li>
          <strong>
            <code>shouldRevalidate</code>
          </strong>{" "}
          is honored: when it returns <code>false</code>{" "}
          the server skips the loader and renders from the echoed data. Always-revalidate is the
          default, so first paint, hard navigations, and routes without it are never stale.
        </li>
        <li>
          <strong>Deferred data is whole at the end.</strong> The <code>&lt;Await&gt;</code>{" "}
          content streams, but the Flight payload is emitted once all boundaries resolve, so a soft
          navigation to a deferred route carries the resolved value rather than re-streaming the
          chunk.
        </li>
        <li>
          <strong>
            <code>useBlocker</code>
          </strong>{" "}
          guards in-app navigations and browser back/forward, not a hard reload or tab close. Add a
          {" "}
          <code>beforeunload</code> handler where you need that.
        </li>
        <li>
          <strong>Prisma</strong> is rewired to the Rust-free Deno client automatically; run{" "}
          <code>deno task prisma:setup</code> once. See <a href="/docs/database">Databases</a>.
        </li>
      </ul>
      <p>
        The full list of divergences lives in{" "}
        <a
          href="https://github.com/Brainwires/denext/blob/main/KNOWN-LIMITATIONS.md#migration-remix-runs-on-the-denextremix-runtime"
          rel="noopener"
        >
          KNOWN-LIMITATIONS
        </a>{" "}
        under "Migration: Remix runs on the denext/remix runtime".
      </p>

      <h2>After the migration</h2>
      <p>
        The result is a regular denext app. New routes can be written the denext way (a Server
        Component in <code>page.tsx</code>, see{" "}
        <a href="/docs/routing">Routing</a>) alongside the migrated Remix routes; there is no need
        to convert the old ones. Build and serve with <code>deno task build</code> then{" "}
        <code>deno task start</code>; see <a href="/docs/deploy">Deployment</a>.
      </p>
      <Callout kind="note">
        Starting fresh instead? Skip the runtime and import from <code>denext</code> and{" "}
        <code>denext/server</code> directly. See{" "}
        <a href="/docs/getting-started">Getting started</a>. Coming from Next.js? See{" "}
        <a href="/docs/migrating">Migrating from Next.js</a>.
      </Callout>
    </DocsShell>
  );
}
