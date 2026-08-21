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
      lead="SPA mode runs a client-only React app on denext — “React but not Next.” There is no app/ directory and no server rendering: denext bundles a single entry, wraps it in an HTML shell, and serves that shell for every navigation. Your app owns its own routing and state; denext provides the bundler, the CSS pipeline, the dev server with live reload, and — via export + deno desktop — native packaging. It is the on-ramp for bringing an existing Vite-style React SPA onto denext's toolchain and its small, zero-npm runtime without restructuring it into the App Router."
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
        {`denext dev      # dev server + live reload
denext build    # production build → .denext/
denext start    # serve the production build
denext export   # static export → out/  (what deno desktop packages)`}
      </Code>

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
        import map (the same aliases the App Router uses). When your project has npm React
        installed, SPA mode automatically bundles through the next-compat rewrite, so even an npm
        library's own <code>import "react"</code>{" "}
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
          alongside <code>denext dev</code>.
        </li>
      </ul>

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

      <h2>Package as a desktop app</h2>
      <p>
        <code>denext export</code> writes a static <code>out/</code>{" "}
        — a shell, the client bundle, and your <code>public/</code>{" "}
        assets — that any host can serve. It is byte-compatible with what <code>deno desktop</code>
        {" "}
        wraps in a native window, so the same build ships to the web and to the desktop:
      </p>
      <Code lang="bash">
        {`denext export
deno desktop desktop.ts   # a Deno.serve over out/ in a native WebView window`}
      </Code>

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
          <strong>Live reload, not Fast Refresh.</strong>{" "}
          In dev, a source change triggers a full reload (component state is not preserved across
          edits). The App Router's state-preserving Fast Refresh does not apply to a foreign SPA
          entry.
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
