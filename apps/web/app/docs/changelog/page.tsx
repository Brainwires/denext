// The repo's CHANGELOG.md, rendered through the docs shell at build/export time — the same
// first-party Markdown renderer content collections use, so the site needs no extra tooling.
// One page, newest release first; the "On this page" rail lists the versions.
import { DocsShell } from "../../../components/ui.tsx";
import { renderMarkdown, rewriteDocLinks } from "../../../lib/markdown.ts";
import { tocFromHtml } from "../../../lib/toc.ts";

export const metadata = {
  title: "Changelog",
  description: "Every denext release, newest first — what was added, changed, fixed, and removed.",
};

const CHANGELOG = new URL("../../../../../CHANGELOG.md", import.meta.url);

export default async function Changelog() {
  const src = await Deno.readTextFile(CHANGELOG);
  // The file's own H1 + intro paragraph become the shell's title + lead.
  const body = src.replace(/^# Changelog\s*\n/, "");
  // Old entries link root files relatively (`./KNOWN-LIMITATIONS.md`); rewrite them to the docs
  // route that renders the file, or the GitHub blob URL, exactly as MarkdownDoc does.
  const html = rewriteDocLinks(renderMarkdown(body), "CHANGELOG.md");
  return (
    <DocsShell
      active="changelog"
      title="Changelog"
      lead="Every release, newest first. This is the repository's CHANGELOG.md, rendered — version headings link to the JSR release."
      toc={tocFromHtml(html)}
    >
      <div class="md" dangerouslySetInnerHTML={{ __html: html }} />
    </DocsShell>
  );
}
