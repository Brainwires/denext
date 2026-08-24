import type { LayoutProps } from "denext/server";

/** The documented version of denext these docs describe. */
export const DOCS_VERSION = "1.3.0";

export const metadata = {
  title: "denext — a React framework for Deno",
  description:
    "denext runs React and the Next.js App Router on Deno with its own small React core — a zero-npm runtime, Server Components, Server Actions, and pages that ship 0 KB of JavaScript. Plus what stock React can't: Qwik-style resumability on React's own API, and Astro-style islands with per-component lazy hydration.",
  head: [
    // The prod origin (nginx on biscuits) now serves `Cache-Control: no-store`, so
    // the CDN caches nothing and an rsynced change is live immediately. The `?v=`
    // was a one-time bust to step off a previously-cached bare `/styles.css` entry
    // at the edge; it's harmless to keep and needn't be bumped again under no-store.
    `<link rel="stylesheet" href="/styles.css?v=1.4.0">`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
    `<link rel="mask-icon" href="/favicon.svg" color="#7aa2ff">`,
    `<meta name="theme-color" content="#0a0c11">`,
  ].join(""),
};

export default function RootLayout({ children }: LayoutProps) {
  return (
    <div class="site">
      <header class="topbar">
        <a class="brand" href="/">
          <span class="logo">▲</span> denext
        </a>
        <a
          class="ver"
          href="https://jsr.io/@denext/denext"
          title="denext on JSR"
        >
          v{DOCS_VERSION}
        </a>
        <nav class="topnav">
          <a href="/docs/getting-started">Docs</a>
          <a href="/docs/migrating">Migrate</a>
          <a href="https://github.com/Brainwires/denext" rel="noopener">
            GitHub
          </a>
          <a href="https://jsr.io/@denext" rel="noopener">JSR</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer class="sitefoot">
        denext v{DOCS_VERSION} · built with denext · static-exported · this page ships{" "}
        <strong>0 KB</strong> of JavaScript ·{" "}
        <a href="https://jsr.io/@denext" rel="noopener">JSR</a> ·{" "}
        <a href="https://github.com/Brainwires/denext" rel="noopener">GitHub</a>
      </footer>
    </div>
  );
}
