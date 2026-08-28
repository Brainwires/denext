// Renders the repo-root CONTRIBUTING.md into the docs site so contributors can read it here
// too (single source of truth — no duplicated copy). The file has no frontmatter, so its own
// "# Contributing to denext" H1 is the page heading; `active` drives the sidebar highlight.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Contributing",
  description:
    "How to contribute to denext — the checks, the run-from-JSR build rule, lint rules, releasing, and conventions.",
};

export default async function Contributing() {
  return await MarkdownDoc({
    url: new URL("../../../../../CONTRIBUTING.md", import.meta.url),
    active: "contributing",
  });
}
