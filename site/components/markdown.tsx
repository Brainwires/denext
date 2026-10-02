// Markdown authoring for the docs site. A doc page can be written as a `.md`
// file with frontmatter (title / lead / slug) and dropped into the DocsShell via
// <MarkdownDoc url={new URL("./content.md", import.meta.url)} />. Rendering runs
// on the server at build/export time (Server Component, zero client JavaScript),
// so the emitted HTML is fully static.

import { DocsShell } from "./ui.tsx";
import { renderDoc } from "../lib/markdown.ts";
import { tocFromHtml } from "../lib/toc.ts";

/** Render the raw HTML produced by the Markdown renderer. */
function MarkdownBody({ html }: { html: string }) {
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Read a Markdown file and render it inside the docs shell. `title`, `lead`, and
 * the active-nav `slug` come from the file's frontmatter (a file with no frontmatter
 * title uses its leading H1); pass `active` to override the sidebar highlight when it
 * differs from the frontmatter slug, `title`/`lead` to override the heading, and
 * `sourcePath` (repo-relative) for a file rendered from outside the site, so its
 * relative links are rewritten to docs routes / GitHub URLs.
 */
export async function MarkdownDoc(
  { url, active, title, lead, sourcePath }: {
    url: string | URL;
    active?: string;
    title?: string;
    lead?: string;
    sourcePath?: string;
  },
) {
  const src = await Deno.readTextFile(url);
  const { frontmatter, html } = renderDoc(src, { sourcePath });
  return (
    <DocsShell
      active={active ?? frontmatter.slug ?? ""}
      title={title ?? frontmatter.title ?? ""}
      lead={lead ?? frontmatter.lead}
      toc={tocFromHtml(html)}
    >
      <MarkdownBody html={html} />
    </DocsShell>
  );
}
