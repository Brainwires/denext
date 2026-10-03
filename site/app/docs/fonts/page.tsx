// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Fonts",
  description:
    "Self-hosted fonts with no runtime request: denext's localFont, and the next/font compat with Next's metric-matched fallback faces.",
};

export default async function Fonts() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
