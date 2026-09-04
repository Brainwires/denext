import { DocsShell } from "../../../components/ui.tsx";
import reference from "./reference.json" with { type: "json" };

/** A module name → a URL-safe single segment (`denext/server` → `denext-server`). */
const slug = (m: string) => m.replace(/\//g, "-");
const total = reference.groups.reduce((n, g) => n + g.symbols.length, 0);

/** One-line blurb per stable entry point (a new module without one just shows its count). */
const BLURB: Record<string, string> = {
  "denext": "The main entrypoint — JSX runtime, hooks, components, client navigation, SSR.",
  "denext/server":
    "createApp / serve, middleware, caching, Server Actions, cookies & sessions, image optimization.",
  "denext/client": "The browser reconciler + hydration, client hooks, and soft navigation.",
  "denext/devtools": "The glass-box DevTools inspector API.",
  "denext/testing": "In-process app & component testing (no browser) + route conformance probing.",
  "denext/live": "Live Server Components — server-pushed boundary updates.",
  "denext/lazy": "Lazy / deferred module + island hydration helpers.",
  "denext/desktop": "Desktop packaging runtime.",
  "denext/cli/command": "The CLI command contract (for plugins contributing verbs).",
};

export const metadata = {
  title: "API reference",
  description:
    "Every public export of denext, browseable by entry point — auto-generated from the source with deno doc.",
};

export default function ApiIndex() {
  return (
    <DocsShell
      active="api"
      title="API reference"
      lead="Every public export of denext, generated straight from the source with deno doc so it never drifts. Browse by entry point."
    >
      <p>
        {total} symbols across {reference.groups.length} entry points. Regenerate with{" "}
        <code>deno task docs:api</code>.
      </p>
      <div class="api-index">
        {reference.groups.map((g) => (
          <a
            key={g.module}
            class="api-card"
            href={`/docs/api/${slug(g.module)}`}
          >
            <span class="api-card-head">
              <code>{g.module}</code>
              <span class="api-card-count">{g.symbols.length}</span>
            </span>
            {BLURB[g.module] ? <span class="api-card-blurb">{BLURB[g.module]}</span> : null}
          </a>
        ))}
      </div>
    </DocsShell>
  );
}
