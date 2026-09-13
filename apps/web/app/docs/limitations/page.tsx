// Renders the repo-root KNOWN-LIMITATIONS.md into the docs site so the honest-edges list reads
// here too (single source of truth — no duplicated copy). The file has no frontmatter, so its
// own H1 is split off the body by `renderDoc` and `title` supplies the shell's page heading;
// `sourcePath` rewrites its repo-relative links to docs routes / GitHub URLs, and `active`
// drives the sidebar highlight.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Known limitations",
  description:
    "The genuine React/Next surface gaps and the bounded scope of denext's own capabilities — what is missing or wrong today.",
};

export default async function Limitations() {
  return await MarkdownDoc({
    url: new URL("../../../../../KNOWN-LIMITATIONS.md", import.meta.url),
    active: "limitations",
    title: "Known limitations",
    sourcePath: "KNOWN-LIMITATIONS.md",
  });
}
