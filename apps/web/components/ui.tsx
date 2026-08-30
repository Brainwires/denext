// Shared, server-only UI for the docs site. Nothing here is a "use client" island,
// so every page that uses it ships ZERO client JavaScript.

import type { VNodeChildren } from "denext";

/** The docs navigation, grouped into sections. */
export const NAV: {
  group: string;
  items: { slug: string; label: string }[];
}[] = [
  {
    group: "Start",
    items: [
      { slug: "getting-started", label: "Getting started" },
      { slug: "routing", label: "Routing" },
      { slug: "migrating", label: "Migrating from Next.js" },
    ],
  },
  {
    group: "Build with it",
    items: [
      { slug: "data", label: "Data & caching" },
      { slug: "rendering", label: "Rendering strategies" },
      { slug: "server-actions", label: "Server Actions" },
      { slug: "live", label: "Live components" },
      { slug: "islands", label: "Islands & hydration" },
      { slug: "resumability", label: "Resumability" },
      { slug: "htmx", label: "htmx" },
      { slug: "effect", label: "Effect" },
      { slug: "spa", label: "SPA mode" },
      { slug: "middleware", label: "Middleware" },
      { slug: "auth", label: "Auth" },
      { slug: "database", label: "Databases" },
    ],
  },
  {
    group: "Polish",
    items: [
      { slug: "metadata", label: "Metadata & SEO" },
      { slug: "styling", label: "Styling" },
      { slug: "images", label: "Images" },
      { slug: "browser-apis", label: "Browser APIs" },
    ],
  },
  {
    group: "Ship it",
    items: [
      { slug: "devtools", label: "DevTools" },
      { slug: "testing", label: "Testing" },
      { slug: "deploy", label: "Deployment" },
      { slug: "desktop", label: "Desktop apps (macOS)" },
    ],
  },
  {
    group: "Reference",
    items: [
      { slug: "config", label: "Configuration" },
      { slug: "api", label: "API reference" },
    ],
  },
  {
    group: "Contribute",
    items: [
      { slug: "contributing", label: "Contributing" },
    ],
  },
];

/** A syntax-neutral code block (whitespace preserved, HTML auto-escaped). */
export function Code({ children, lang }: { children: string; lang?: string }) {
  return (
    <pre class="code" data-lang={lang}>
      <code>{children}</code>
    </pre>
  );
}

/** A callout box for notes/warnings. */
export function Callout(
  { kind = "note", children }: {
    kind?: "note" | "warn";
    children: VNodeChildren;
  },
) {
  return <aside class={`callout ${kind}`}>{children}</aside>;
}

/** The docs shell: sidebar + article. `active` is the current page's slug. */
export function DocsShell(
  { active, title, lead, children }: {
    active: string;
    title: string;
    lead?: string;
    children: VNodeChildren;
  },
) {
  return (
    <div class="docs">
      <nav class="sidebar" aria-label="Docs">
        {NAV.map((section) => (
          <div key={section.group} class="navgroup">
            <span class="navgroup-title">{section.group}</span>
            <ul>
              {section.items.map((item) => (
                <li key={item.slug}>
                  <a
                    href={`/docs/${item.slug}`}
                    class={item.slug === active ? "active" : undefined}
                    aria-current={item.slug === active ? "page" : undefined}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <article class="article">
        <header class="article-head">
          <h1>{title}</h1>
          {lead && <p class="lead">{lead}</p>}
        </header>
        {children}
      </article>
    </div>
  );
}
