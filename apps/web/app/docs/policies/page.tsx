// Renders the repo-root POLICIES.md into the docs site so the standing guardrails and the
// security policy read here too (single source of truth — no duplicated copy). The file has no
// frontmatter, so its own "# denext — Policies (standing)" H1 becomes the shell's page heading
// (split off the body by `renderDoc`); `sourcePath` rewrites its repo-relative links to docs
// routes / GitHub URLs, and `active` drives the sidebar highlight.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Policies & security policy",
  description:
    "The standing engineering guardrails and the security policy: supported versions and how to report a vulnerability privately.",
};

export default async function Policies() {
  return await MarkdownDoc({
    url: new URL("../../../../../POLICIES.md", import.meta.url),
    active: "policies",
    sourcePath: "POLICIES.md",
  });
}
