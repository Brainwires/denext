// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Project layout",
  description:
    "Every file and folder a denext app can have, what each one does, and which page explains it — from deno.json to the generated .denext/ directory.",
};

export default async function ProjectLayout() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
