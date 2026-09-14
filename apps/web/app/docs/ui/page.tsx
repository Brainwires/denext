// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Project UI",
  description:
    "denext ui: a loopback project GUI — schema-driven config editor, plugins, generate, Docker, a setup wizard, and project CLI verbs.",
};

export default async function Ui() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
