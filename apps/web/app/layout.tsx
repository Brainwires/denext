import type { LayoutProps } from "denext/server";
import { VERSION } from "denext";

/**
 * The denext version these docs describe — derived from the framework's own `VERSION`
 * (bumped by every release) so it can never drift. Do NOT hardcode a version here.
 */
export const DOCS_VERSION = VERSION;

/** The canonical production origin — makes `metadataBase`-relative URLs (og:image,
 * canonical, sitemap) absolute. Every page inherits this. */
export const SITE_ORIGIN = "https://denext.dev";

const DESCRIPTION =
  "denext runs React and the Next.js App Router on Deno with its own small React core — a zero-npm runtime, Server Components, Server Actions, and pages that ship 0 KB of JavaScript. Plus what stock React can't: Qwik-style resumability on React's own API, and Astro-style islands with per-component lazy hydration.";

export const metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: "denext — a React framework for Deno",
  description: DESCRIPTION,
  // Static OG/Twitter bits every page shares (denext absolutizes the image against
  // metadataBase). The PER-PAGE og:title/description/url + twitter:title/description
  // are injected from each page's own <title>/<meta description> by scripts/seo.ts,
  // since denext doesn't fall og:title back to the page title.
  openGraph: {
    type: "website",
    siteName: "denext",
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "denext" }],
  },
  twitter: {
    card: "summary_large_image",
    images: "/og.png",
  },
  head: [
    `<link rel="stylesheet" href="/styles.css">`,
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
