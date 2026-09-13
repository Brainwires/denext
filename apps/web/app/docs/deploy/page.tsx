// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Deployment",
  description:
    "denext ships secure, production-minded defaults; a few operational responsibilities are yours to configure at the edge or platform.",
};

export default async function Deploy() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
