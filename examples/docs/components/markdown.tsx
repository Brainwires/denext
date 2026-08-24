// Markdown authoring for the docs site. A doc page can be written as a `.md`
// file with frontmatter (title / lead / slug) and dropped into the DocsShell via
// <MarkdownDoc url={new URL("./content.md", import.meta.url)} />. Rendering runs
// on the server at build/export time (Server Component, zero client JavaScript),
// so the emitted HTML is fully static.

import { DocsShell } from "./ui.tsx";
import { renderDoc } from "../lib/markdown.ts";

/** Render the raw HTML produced by the Markdown renderer. */
function MarkdownBody({ html }: { html: string }) {
  return <div class="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Read a Markdown file and render it inside the docs shell. `title`, `lead`, and
 * the active-nav `slug` come from the file's frontmatter; pass `active` to
 * override the sidebar highlight when it differs from the frontmatter slug.
 */
export async function MarkdownDoc(
  { url, active }: { url: string | URL; active?: string },
) {
  const src = await Deno.readTextFile(url);
  const { frontmatter, html } = renderDoc(src);
  return (
    <DocsShell
      active={active ?? frontmatter.slug ?? ""}
      title={frontmatter.title ?? ""}
      lead={frontmatter.lead}
    >
      <MarkdownBody html={html} />
    </DocsShell>
  );
}
