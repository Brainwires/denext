// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Gleam",
  description:
    "Import Gleam compiled to JavaScript from TypeScript, typed: denext add gleam:<package>, the @gleam/ import prefix, and the optional gleam() build plugin.",
};

export default async function Gleam() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
