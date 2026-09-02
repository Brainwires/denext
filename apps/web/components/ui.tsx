// Shared, server-only UI for the docs site. Nothing here is a "use client" island,
// so every page that uses it ships ZERO client JavaScript.

import type { VNodeChildren } from "denext";
import { tocFromVNodes, type TocItem } from "../lib/toc.ts";

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
      { slug: "mcp", label: "MCP server" },
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

/**
 * The docs shell: sidebar + article + an optional right-rail "On this page" TOC.
 * `active` is the current page's slug. The TOC is auto-extracted from the JSX children's
 * h2/h3 headings; pass `toc` explicitly for Markdown/generated content (see MarkdownDoc).
 */
export function DocsShell(
  { active, title, lead, children, toc }: {
    active: string;
    title: string;
    lead?: string;
    children: VNodeChildren;
    toc?: TocItem[];
  },
) {
  const headings = toc ?? tocFromVNodes(children);
  const showToc = headings.length >= 2;
  return (
    <div class={showToc ? "docs has-toc" : "docs"}>
      <nav class="sidebar" aria-label="Docs">
        {
          /* 0-JS responsive nav: on mobile the checkbox toggles the menu; on desktop the
            toggle is hidden and the groups are always shown. */
        }
        <input type="checkbox" id="docnav-toggle" class="nav-check" />
        <label for="docnav-toggle" class="nav-toggle">Menu</label>
        <div class="navgroups">
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
        </div>
      </nav>
      <article class="article">
        <header class="article-head">
          <h1>{title}</h1>
          {lead && <p class="lead">{lead}</p>}
        </header>
        {children}
      </article>
      {showToc && (
        <aside class="toc" aria-label="On this page">
          <span class="toc-title">On this page</span>
          <ul>
            {headings.map((h) =>
              h.children && h.children.length
                ? (
                  <li key={h.id} class="toc-sec" data-sec={h.id}>
                    <a class="toc-seclink" href={h.href ?? `#${h.id}`}>
                      {h.text}
                    </a>
                    <ul class="toc-sublist">
                      {h.children.map((c) => (
                        <li key={c.id} class="toc-subitem">
                          <a class="toc-sublink" href={`#${c.id}`}>{c.text}</a>
                        </li>
                      ))}
                    </ul>
                  </li>
                )
                : (
                  <li key={h.id} class={`toc-l${h.level}`}>
                    <a href={h.href ?? `#${h.id}`}>{h.text}</a>
                  </li>
                )
            )}
          </ul>
        </aside>
      )}
    </div>
  );
}
