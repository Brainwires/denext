// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = { title: "Styling" };

export default async function Styling() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
