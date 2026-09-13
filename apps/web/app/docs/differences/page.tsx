// Renders the repo-root KNOWN-DIFFERENCES.md into the docs site so the deliberate-differences
// list reads here too (single source of truth — no duplicated copy). The file has no
// frontmatter, so its own "# denext — Known differences" H1 becomes the shell's page heading
// (split off the body by `renderDoc`); `sourcePath` rewrites its repo-relative links to docs
// routes / GitHub URLs, and `active` drives the sidebar highlight.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Deliberate differences",
  description:
    "Where denext behaves differently from React and Next.js on purpose — documented behavior, not gaps.",
};

export default async function Differences() {
  return await MarkdownDoc({
    url: new URL("../../../../../KNOWN-DIFFERENCES.md", import.meta.url),
    active: "differences",
    sourcePath: "KNOWN-DIFFERENCES.md",
  });
}
