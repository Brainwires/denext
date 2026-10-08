import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "SPA mode",
  description:
    "Host a client-only React app on denext — React but not Next. No app/ directory, no SSR: one client entry, an HTML shell, and native packaging.",
};

export default function Spa() {
  return (
    <DocsShell
      active="spa"
      title="SPA mode"
      lead="SPA mode runs a client-only React app on denext — “React but not Next.” There is no app/ directory and no server rendering: denext bundles a single entry, wraps it in an HTML shell, and serves that shell for every navigation. Your app owns its own routing and state; denext provides the bundler, the CSS pipeline, the dev server with state-preserving Fast Refresh, and — via export + deno desktop — native packaging. It is the on-ramp for bringing an existing Vite-style React SPA onto denext's toolchain and its small, zero-npm runtime without restructuring it into the App Router."
    >
      <h2>When to use it</h2>
      <p>
        Most denext apps want the App Router: server components, 0&nbsp;KB-by-default pages, and
        SSR. Reach for SPA mode when you have the opposite shape — a{" "}
        <strong>client-heavy application</strong>{" "}
        (an editor, a dashboard, an internal tool, a desktop app) that is interactive from the first
        paint, keeps its state on the client, and gains nothing from server rendering. That is
        exactly the kind of app that is usually built with Vite; SPA mode lets it run on denext's
        runtime and ship as a single <code>deno desktop</code> binary instead.
      </p>

      <h2>Turn it on</h2>
      <p>
        Set <code>mode: "spa"</code> in <code>denext.config.ts</code> and point{" "}
        <code>spa.entry</code> at your client entry. There is no <code>app/</code> directory.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",   // the module that mounts your app
    title: "My App",           // <title> for the generated shell
    // rootId: "root",         // element id the shell exposes (default "root")
  },
} satisfies DenextConfig;`}
      </Code>
      <p>
        The entry mounts the app itself — a plain{" "}
        <code>createRoot(...).render(...)</code>, exactly like a Vite{" "}
        <code>main.tsx</code>. denext stays out of the mount:
      </p>
      <Code lang="tsx">
        {`// src/main.tsx
import { createRoot } from "denext/client";
import { App } from "./app.tsx";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);`}
      </Code>
      <p>
        Then use the normal commands — no <code>app/</code> required:
      </p>
      <Code lang="bash">
        {`denext dev      # dev server + Fast Refresh
denext build    # production build → .denext/
denext start    # serve the production build
denext export   # static export → out/  (what deno desktop packages)`}
      </Code>

      <h2>Fast Refresh in dev</h2>
      <p>
        Editing a component in <code>denext dev</code> updates it in place and{" "}
        <strong>keeps its state</strong>{" "}
        — a counter stays on its count, an open menu stays open — instead of reloading the page.
        denext instruments each of your modules with a stable component identity at bundle time, so
        a saved edit re-imports the rebuilt bundle and reconciles the new code onto the live
        component tree. Editing the entry module itself (the one that calls{" "}
        <code>createRoot</code>), or a change that alters a component's hook order, falls back to a
        full reload automatically. This works on the <strong>npm-React</strong>{" "}
        path (the common case — an app with <code>node_modules/react</code>, or{" "}
        <code>compatibilityMode: true</code>); a purely denext-native SPA still full-reloads on
        edit.
      </p>

      <h2>Bring your own router and data layer</h2>
      <p>
        Because denext never calls into the app after mounting it, everything above the reconciler
        is yours: use{" "}
        <strong>TanStack Router</strong>, React Router, a hash router, a client store, a WebSocket
        client, or an <code>Effect</code>{" "}
        runtime — denext neither provides nor interferes with any of it. The server serves the same
        HTML shell for every path (a history-API fallback), so client-side deep links work.
      </p>
      <Callout kind="note">
        Running an app written against <strong>npm React</strong> works: alias{" "}
        <code>react</code>/<code>react-dom</code> to denext with the{" "}
        <a href="/docs/migrating">next-compat</a>{" "}
        import map (the same aliases the App Router uses). When your project has npm React installed
        — or you set <code>compatibilityMode: true</code>{" "}
        — SPA mode automatically bundles through the next-compat rewrite, so even an npm library's
        own <code>import "react"</code>{" "}
        resolves to denext's single React — the whole app (Radix, TanStack Router, …) renders on one
        reconciler.
      </Callout>

      <h2>
        Environment variables — <code>import.meta.env</code>
      </h2>
      <p>
        A Vite app reads config from <code>import.meta.env.VITE_*</code>. Declare those values in
        {" "}
        <code>spa.env</code> and denext substitutes them at build time (the Vite <code>define</code>
        {" "}
        analogue), on the next-compat path:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    env: { VITE_API_URL: "https://api.example.com" },
  },
} satisfies DenextConfig;

// in your app: import.meta.env.VITE_API_URL → "https://api.example.com"`}
      </Code>

      <h2>Content-Security-Policy (opt-in)</h2>
      <p>
        A client-only React SPA (Vite/CRA and denext alike) ships no CSP by default — it's the app's
        or host's call — so denext keeps it opt-in. Set <code>spa.csp</code>{" "}
        and denext emits a strict policy as a <code>&lt;meta http-equiv&gt;</code>{" "}
        in the shell, so it applies for <code>export</code> (any static host),{" "}
        <code>start</code>, and <code>dev</code> alike:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    csp: "strict", // default-src 'self'; script-src 'self'; object-src 'none'; …
    // …or add global opt-ins (your API host, a CDN, etc.):
    // csp: { connectSrc: ["https://api.example.com"] },
    // (also scriptSrc, styleSrc, imgSrc, fontSrc, frameSrc, mediaSrc, workerSrc)
  },
} satisfies DenextConfig;`}
      </Code>
      <p>
        <code>style-src-attr 'unsafe-inline'</code> is included so React <code>style={"{{}}"}</code>
        {" "}
        keeps working. <code>frame-ancestors</code> is header-only (ignored in{" "}
        <code>&lt;meta&gt;</code>); the always-on <code>X-Frame-Options: SAMEORIGIN</code>{" "}
        covers clickjacking, and you can set <code>frame-ancestors</code>{" "}
        at your edge if you need it.
      </p>

      <h2>Assets, Tailwind &amp; codegen (npm-React apps)</h2>
      <p>
        On the npm-React (next-compat) path, Vite-style asset imports work:
      </p>
      <Code lang="tsx">
        {`import wasmUrl from "./thing.wasm?url";     // emitted file → its URL
import Worker from "./worker.ts?worker";     // new Worker(url) — bundled chunk
import raw from "./readme.md?raw";           // file text
import inline from "./icon.svg?inline";      // data: URL
const u = new URL("./asset.bin", import.meta.url); // emitted + rewritten`}
      </Code>
      <p>
        Every emitted asset lands under <code>/_denext/client/assets/</code>{" "}
        (served by the SPA server, copied by{" "}
        <code>export</code>). Two build-tool integrations that esbuild can't run for you:
      </p>
      <ul>
        <li>
          <strong>Tailwind</strong>: set <code>tailwind: {"{ input, output }"}</code> in{" "}
          <code>denext.config.ts</code> and import the compiled <em>output</em>{" "}
          from your entry (not the raw <code>@import "tailwindcss"</code> input).
        </li>
        <li>
          <strong>Route codegen</strong> (e.g. TanStack Router): run it out-of-band —{" "}
          <code>tsr generate</code> in a <code>prebuild</code> step, <code>tsr watch</code>{" "}
          alongside <code>denext dev</code>. <code>examples/tanstack-router</code>{" "}
          in the repo is a stock file-based TanStack Router app wired this way. With{" "}
          <code>spa.tanstackRouter</code> set (below), <code>denext build</code> and{" "}
          <code>export</code> regenerate the route tree themselves, as the Vite plugin does.
        </li>
      </ul>

      <h2>Vite build parity</h2>
      <p>
        Four things a Vite build does that a migrated app may rely on. All apply to{" "}
        <code>denext build</code> and <code>denext export</code>; <code>denext dev</code>{" "}
        does not code-split, emit, or write a manifest.
      </p>

      <h3>
        Route code-splitting — <code>spa.tanstackRouter</code>
      </h3>
      <p>
        TanStack Router's <code>autoCodeSplitting</code>{" "}
        moves each file route's component (and its loader, error, pending and not-found components)
        into its own chunk that the router fetches when the route is visited, so the startup bundle
        holds only the router and the route tree. denext runs the same splitter (
        <code>@tanstack/router-plugin</code>'s compiler, a build-time tool) on the npm-React path:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
spa: {
  entry: "./src/main.tsx",
  tanstackRouter: {
    autoCodeSplitting: true,
    // routesDirectory / generatedRouteTree: default to tsr.config.json, else ./src/routes
  },
}`}
      </Code>
      <p>
        <code>denext migrate</code> sets it when vite.config's <code>tanstackRouter()</code> has
        {" "}
        <code>autoCodeSplitting: true</code>.
      </p>

      <h3>
        Chunk-load errors — <code>vite:preloadError</code>
      </h3>
      <p>
        After a deploy (or an over-the-air update) replaces the content-hashed chunks, a tab still
        running the old entry can ask for a chunk that is gone. As in a Vite build, the failed
        dynamic import dispatches a cancelable <code>vite:preloadError</code> event on{" "}
        <code>window</code> with the error as <code>event.payload</code>, and a{" "}
        <code>denext:chunkError</code> event of the same shape. Call <code>preventDefault()</code>
        {" "}
        to suppress the error (the import then resolves to{" "}
        <code>undefined</code>) — typically to reload once onto the new build:
      </p>
      <Code lang="ts">
        {`addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  if (!sessionStorage.getItem("reloaded")) {
    sessionStorage.setItem("reloaded", "1");
    location.reload();
  }
});`}
      </Code>
      <p>
        Without a listener that prevents it, the import rejects with the original error, as before.
        It covers every split chunk of a production SPA bundle (both bundlers); it adds nothing to
        an App Router app.
      </p>

      <h3>Files a plugin emits</h3>
      <p>
        A Vite plugin that writes a generated file from <code>generateBundle</code>{" "}
        (a licence list, a version stamp) has a denext equivalent: a plugin build step's{" "}
        <code>emitFile</code>, which publishes the file at the site root — in the export, and from
        {" "}
        <code>denext start</code>{" "}
        after a build. An existing Vite plugin of that kind runs unchanged through{" "}
        <code>viteEmitterPlugin</code>:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
import { viteEmitterPlugin } from "denext/plugin-kit";
import { licensesPlugin } from "./scripts/licenses.ts";

export default {
  mode: "spa",
  plugins: [viteEmitterPlugin(licensesPlugin({ fileName: "third-party-licenses.json" }))],
  spa: { entry: "./src/main.tsx" },
} satisfies DenextConfig;`}
      </Code>
      <p>
        <code>denext migrate</code>{" "}
        writes this for an emitter imported from the app's own module; one it cannot carry over
        (other build hooks, values from vite.config) is listed for review. See{" "}
        <a href="/docs/plugins#seam-3--build-steps">Plugins › build steps</a>.
      </p>

      <h3>
        Build manifest — <code>spa.viteManifest</code>
      </h3>
      <p>
        A server written for a Vite build may read <code>.vite/manifest.json</code>{" "}
        to learn which files are content-hashed and can be served as <code>immutable</code>.{" "}
        <code>{"spa: { viteManifest: true }"}</code>{" "}
        writes one into the export, in Vite's shape, listing every content-hashed file under{" "}
        <code>_denext/client/</code>:
      </p>
      <Code lang="json">
        {`{
  "_denext/client/chunk-AB12CD34.js": { "file": "_denext/client/chunk-AB12CD34.js" }
}`}
      </Code>
      <p>
        The entry (<code>index.js</code>) and stylesheet (<code>index.css</code>) keep their names
        across builds, so they are not listed.
      </p>

      <h2>Styling</h2>
      <p>
        denext's CSS pipeline runs in SPA mode too. Import a stylesheet from anywhere in your
        entry's graph and denext transforms it and serves it as one{" "}
        <code>&lt;link&gt;</code>ed sheet; CSS Modules and <a href="/docs/styling">Tailwind</a>{" "}
        work the same as in an App Router app.
      </p>
      <Code lang="tsx">
        {`import "./styles.css";      // global styles
import s from "./card.module.css"; // scoped classes: s.card`}
      </Code>

      <h2>
        Talking to a backend — <code>spa.proxy</code>
      </h2>
      <p>
        A client-only SPA usually talks to a separate backend (an API, a WebSocket). When denext
        serves the app — <code>denext start</code> or the <code>deno desktop</code>{" "}
        window — it can reverse-proxy chosen path prefixes to that backend, the way a Vite dev
        server's <code>server.proxy</code>{" "}
        does, so the client reaches its API on its own origin. HTTP is relayed (with{" "}
        <code>Set-Cookie</code>{" "}
        rebound to the proxy origin) and WebSocket upgrades are bridged with the request{" "}
        <code>Cookie</code> forwarded — enough for a cookie-authenticated socket:
      </p>
      <Code lang="ts">
        {`// denext.config.ts
export default {
  mode: "spa",
  spa: {
    entry: "./src/main.tsx",
    proxy: {
      prefixes: ["/api", "/ws"],        // forwarded to the backend
      target: "http://127.0.0.1:3773",  // your local backend
    },
  },
} satisfies DenextConfig;`}
      </Code>
      <Callout kind="note">
        This is a <strong>desktop/dev convenience</strong> for reaching a <em>local</em>{" "}
        backend — the target must be loopback (127.0.0.1 / localhost) unless you set{" "}
        <code>allowNonLoopback: true</code>. It is not a production reverse proxy; front your app
        with a real one for that.
      </Callout>

      <h2>Package as a desktop app</h2>
      <p>
        <code>denext export</code> writes a static <code>out/</code>{" "}
        — a shell, the client bundle, and your <code>public/</code>{" "}
        assets — that any host can serve. It is byte-compatible with what <code>deno desktop</code>
        {" "}
        wraps in a native window, so the same build ships to the web and to the desktop. The{" "}
        <code>desktop.ts</code> entry is a thin call to denext's desktop runtime, which serves{" "}
        <code>out/</code>, applies your <code>spa.proxy</code>, and adopts the window:
      </p>
      <Code lang="tsx">
        {`// desktop.ts — generated by \`denext migrate --desktop\`
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import config from "./denext.config.ts";

await runDesktop({
  importMetaUrl: import.meta.url,
  proxy: config.spa?.proxy,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});`}
      </Code>
      <p>
        The <code>resolveDesktopCapabilities</code> spread serves the native capabilities{" "}
        <code>denext desktop add</code> enables from this window, as a{" "}
        <code>denext create --desktop</code> entry does; see{" "}
        <a href="/docs/desktop#desktop-capabilities">Desktop apps › Native capabilities</a>.
      </p>
      <Code lang="bash">
        {`deno task desktop   # runs \`export\`, then packages out/ in a native window`}
      </Code>
      <Callout kind="note">
        Use the generated <code>deno task desktop</code> — not a bare{" "}
        <code>deno desktop desktop.ts</code>. The task bakes the flags a working, distributable
        bundle needs: <code>--include out</code>{" "}
        (embed the static export, else the packaged app serves nothing on another machine),{" "}
        <code>--allow-net --allow-read --allow-env</code>{" "}
        (a compiled app runs with no permissions otherwise — the window comes up black on the
        missing <code>PORT</code>), <code>--exclude-unused-npm</code> and{" "}
        <code>--node-modules-dir=none</code>{" "}
        (trim the bundle and resolve the runtime's own npm dep from Deno's global cache — pnpm/yarn
        apps pin <code>nodeModulesDir: "manual"</code>), and <code>--icon</code>{" "}
        when an app icon is present. <code>denext migrate --desktop</code> writes this task for you.
      </Callout>
      <Callout kind="note">
        <code>denext build</code> and <code>denext export</code> write a gzip <code>.gz</code>{" "}
        sibling next to each client asset, for <code>denext start</code>{" "}
        to serve at no per-request cost. A native shell that loads files from its app bundle never
        requests them — for a Capacitor (iOS/Android) build, set{" "}
        <code>{"spa: { precompress: false }"}</code> to keep them out of the bundle.
      </Callout>
      <Callout kind="note">
        <code>{"spa: { ota: true }"}</code>{" "}
        stamps an over-the-air manifest (<code>_denext/ota.json</code>: every file's SHA-256 and
        size, plus a version hashed over them) into the export, so a Capacitor shell with the native
        plugin (<code>denext mobile add-ota</code>) can pull a newer UI without a new app build. Set
        {" "}
        <code>DENEXT_OTA_SIGNING_KEY</code> to sign it. See{" "}
        <a href="/docs/mobile#over-the-air-ui-updates">Over-the-air UI updates</a>.
      </Callout>
      <h3>App icon</h3>
      <p>
        Set <code>spa.desktop.icon</code> in <code>denext.config.ts</code>{" "}
        to point the desktop bundle at any icon file. A finished 1024² PNG (e.g. from your app's own
        icon set) is used verbatim; a web <code>apple-touch-icon</code>/<code>favicon.png</code>
        {" "}
        is auto-detected and composed into Apple's macOS icon template so it isn't rendered
        oversized in the Dock. The prepared icon is written to <code>desktop-icon.png</code>{" "}
        at build time.
      </p>
      <Code lang="ts">
        {`// denext.config.ts
spa: { desktop: { icon: "./assets/app-icon.png" } }`}
      </Code>
      <Callout kind="note">
        Editing <code>spa.desktop.icon</code>{" "}
        and rebuilding is enough when an app icon was present at migrate time (which wires{" "}
        <code>--icon</code> into the task). If migrate found no icon, re-run{" "}
        <code>denext migrate --desktop</code> after setting it so the flag gets wired.
      </Callout>

      <h2>Bundle size</h2>
      <p>
        denext ships its <em>own</em>{" "}
        small React-equivalent instead of React&nbsp;+&nbsp;ReactDOM, so the client download is a
        fraction of the size. On a trivial SPA, the same app bundled with the same bundler (<code>
          deno bundle
        </code>, minified), gzipped:
      </p>
      <Code lang="text">
        {`                              raw      gzip
  denext (own React-equiv)   38.6 KB   13.3 KB
  React 19 + ReactDOM 19    190.2 KB   60.1 KB
  denext is smaller by          4.9×      4.5×`}
      </Code>
      <p>
        Reproduce it with <code>deno run -A bench.ts</code> in the <code>examples/spa</code>{" "}
        example. (React Compiler does not change this — it is a re-render optimization, not a size
        one; the difference is a runtime story.)
      </p>

      <h2>What it does not do</h2>
      <ul>
        <li>
          <strong>No SSR, SSG, or Flight.</strong>{" "}
          The server sends a shell with an empty root element and the app renders on the client. If
          you want server rendering, 0&nbsp;KB-by-default pages, or server components, use the{" "}
          <a href="/docs/routing">App Router</a>{" "}
          instead — that is denext's default and its strength.
        </li>
        <li>
          <strong>The entry mounts itself.</strong> denext bundles <code>spa.entry</code>{" "}
          for its side effects and provides an empty root element; creating the root and rendering
          is your entry's job (as it already is in a Vite app).
        </li>
      </ul>

      <Callout kind="note">
        SPA mode and the App Router are mutually exclusive per project — <code>mode: "spa"</code>
        {" "}
        turns off route scanning entirely. For an app that is mostly server-rendered with a few
        client-heavy screens, prefer the App Router with <code>"use client"</code> islands (or{" "}
        <a href="/docs/resumability">resumability</a>); reach for SPA mode when the <em>whole</em>
        {" "}
        app is client-side.
      </Callout>
    </DocsShell>
  );
}
