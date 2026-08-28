import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "htmx",
  description:
    "First-class htmx on denext via the @denext/htmx plugin: hx-* attributes render verbatim, a pure-htmx page ships 0 KB of denext JS, and the runtime is served from your own origin (zero npm, zero CDN, strict-CSP clean).",
};

export default function Htmx() {
  return (
    <DocsShell
      active="htmx"
      title="htmx"
      lead="denext renders hx-* attributes verbatim and classifies a page that uses only them as static — so an htmx page ships 0 KB of denext JavaScript. The @denext/htmx plugin adds the runtime delivery and ergonomics on top of that: the htmx runtime served from your own origin (zero npm, zero CDN, strict-CSP clean), a typed attribute helper, request/response helpers, and a <Htmx/> component."
    >
      <h2>Why it just works</h2>
      <p>
        denext's attribute model is a{" "}
        <strong>denylist, not an allowlist</strong>: any attribute it doesn't specifically handle is
        written straight through, on both the server render and client hydration. So{" "}
        <code>hx-get</code>, <code>hx-post</code>, <code>hx-swap</code> — every <code>hx-*</code>
        {" "}
        attribute — reaches the DOM untouched with no configuration. And a page that has{" "}
        <em>only</em> htmx attributes (no hooks, no <code>onClick</code>) is classified{" "}
        <a href="/docs/rendering">static</a>, so it ships{" "}
        <strong>zero denext client JavaScript</strong>. htmx does the interactivity; denext just
        renders HTML and serves the runtime.
      </p>

      <h2>Install</h2>
      <p>
        One step — adds the dependency and wires the plugin into <code>denext.config.ts</code>:
      </p>
      <Code lang="sh">{`denext plugin add @denext/htmx`}</Code>
      <p>Or by hand:</p>
      <Code lang="ts">
        {`// denext.config.ts
import { htmx } from "@denext/htmx";

export default {
  plugins: [htmx()],
};`}
      </Code>
      <p>
        Then drop <code>&lt;Htmx/&gt;</code> once in your root layout — it emits the deferred{" "}
        <code>&lt;script&gt;</code> that loads the runtime:
      </p>
      <Code lang="tsx">
        {`// app/layout.tsx
import { Htmx } from "@denext/htmx";

export default function Layout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Htmx />
      </body>
    </html>
  );
}`}
      </Code>
      <Callout kind="note">
        The runtime is <strong>vendored</strong>{" "}
        (the package version tracks the htmx version it wraps) and served from your own origin at
        {" "}
        <code>/_denext/htmx/htmx.min.js</code>{" "}
        — no npm dependency and no CDN. It loads as a classic deferred script, which is what htmx
        expects.
      </Callout>

      <h2>A page and its fragment</h2>
      <p>
        Raw <code>hx-*</code>{" "}
        attributes always work, no import needed. This whole page ships 0 KB of denext JS:
      </p>
      <Code lang="tsx">
        {`// app/page.tsx
export default function Page() {
  return (
    <div>
      <button type="button" hx-post="/clicked" hx-target="#out" hx-swap="innerHTML">
        Click me
      </button>
      <span id="out" />
    </div>
  );
}`}
      </Code>
      <p>
        The fragment endpoint is a normal denext <code>route.ts</code>, answered with{" "}
        <code>htmlResponse</code> — which renders a VNode (or a ready HTML string) and sets any{" "}
        <code>HX-*</code> response directives as headers:
      </p>
      <Code lang="ts">
        {`// app/clicked/route.ts
import { h } from "@denext/denext";
import { htmlResponse } from "@denext/htmx";

export function POST() {
  // Route handlers are .ts (no JSX) — build the fragment with h().
  return htmlResponse(h("strong", {}, "Clicked!"), { retarget: "#out" });
}`}
      </Code>
      <Callout kind="note">
        <strong>Server Actions vs htmx fragments.</strong> denext{" "}
        <a href="/docs/server-actions">Server Actions</a>{" "}
        return JSON or a redirect — they're the RPC vehicle. htmx wants an <em>HTML</em>{" "}
        fragment, so for htmx endpoints return one from a <code>route.ts</code> with{" "}
        <code>htmlResponse</code> rather than from an action.
      </Callout>

      <h2>Typed authoring</h2>
      <p>
        Raw attributes type-check and work as-is. For autocomplete and typo-safety, spread the{" "}
        <code>hx()</code> helper — it maps un-prefixed keys to <code>hx-*</code> attributes (and
        {" "}
        <code>on</code> to <code>hx-on:*</code>):
      </p>
      <Code lang="tsx">
        {`import { hx } from "@denext/htmx";

<input
  type="search"
  name="q"
  {...hx({
    post: "/search",
    trigger: "input changed delay:200ms, search",
    target: "#results",
    swap: "innerHTML",
  })}
/>;`}
      </Code>

      <h2>Reading an htmx request</h2>
      <p>
        Return a fragment for htmx and a full page otherwise — <code>isHtmxRequest</code> and{" "}
        <code>htmxRequest</code> read the incoming <code>HX-*</code> request headers:
      </p>
      <Code lang="ts">
        {`import { htmxRequest, isHtmxRequest } from "@denext/htmx";

export function GET(req: Request) {
  if (isHtmxRequest(req)) {
    const { boosted, target, triggerId, currentUrl } = htmxRequest(req);
    // …return just the fragment
  }
  // …return the full page
}`}
      </Code>
      <p>
        And <code>htmlResponse</code>'s second argument sets the response side —{" "}
        <code>retarget</code>, <code>reswap</code>, <code>reselect</code>, <code>redirect</code>,
        {" "}
        <code>pushUrl</code>, <code>refresh</code>, and <code>trigger</code>{" "}
        (a name, or an object serialized to JSON) — each written as the matching <code>HX-*</code>
        {" "}
        header.
      </p>

      <h2>Content-Security-Policy</h2>
      <p>
        Because the runtime is served from <code>'self'</code>, a strict{" "}
        <code>script-src 'self'</code>{" "}
        policy needs no change — no inline script, no third-party host. Your <code>hx-post</code>/
        <code>hx-get</code> fetches need <code>connect-src 'self'</code>{" "}
        (or the hosts you actually call).
      </p>
      <Callout kind="warn">
        htmx will fetch whatever URL an <code>hx-get</code>/<code>hx-post</code> names, including a
        {" "}
        <code>javascript:</code>-scheme value. htmx only <em>fetches</em>{" "}
        it (it is not evaluated as code), but never interpolate untrusted input into these
        attributes.
      </Callout>

      <h2>CLI</h2>
      <p>
        The plugin contributes a <code>denext htmx</code> verb:
      </p>
      <Code lang="sh">
        {`denext htmx info          # print the vendored htmx version and runtime URL
denext htmx eject [dir]   # copy htmx.min.js into your project (default: public/)`}
      </Code>

      <h2>Where it fits</h2>
      <p>
        htmx is a hypermedia approach: the server sends HTML, htmx swaps it in. It sits alongside
        denext's other <a href="/docs/rendering">rendering strategies</a>{" "}
        rather than replacing them — mix htmx pages with <a href="/docs/islands">islands</a>,{" "}
        <a href="/docs/server-actions">Server Actions</a>, and{" "}
        <a href="/docs/live">Live components</a>{" "}
        in the same app. Reach for htmx when a page is server-driven HTML with light interactivity
        and you'd rather ship no framework JavaScript at all.
      </p>
    </DocsShell>
  );
}
