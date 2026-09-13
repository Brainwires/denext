// Renders the repo-root FEATURES.md into the docs site so the feature ledger reads here too
// (single source of truth — no duplicated copy). The file has no frontmatter, so its own H1 is
// split off the body by `renderDoc` and `title` supplies the shell's page heading; `sourcePath`
// rewrites its repo-relative links to docs routes / GitHub URLs, and `active` drives the sidebar
// highlight.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Features",
  description:
    "The master list of everything denext ships, plus the mechanism-by-mechanism ledger of where it beats React and Next.js.",
};

export default async function Features() {
  return await MarkdownDoc({
    url: new URL("../../../../../FEATURES.md", import.meta.url),
    active: "features",
    title: "Features",
    sourcePath: "FEATURES.md",
  });
}
