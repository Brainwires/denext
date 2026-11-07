// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Markdown",
  description:
    "denext/markdown: renderMarkdown to an HTML string and <Markdown> to elements with your own components, escaped by default, with opt-in sanitized raw HTML and a link and image URL policy.",
};

export default async function MarkdownPage() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
