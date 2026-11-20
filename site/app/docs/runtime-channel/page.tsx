// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "The runtime channel",
  description:
    "Move to a newer denext runtime without waiting for a denext release: a signed index, hash-locked release documents, explicit upgrades and a project lock.",
};

export default async function RuntimeChannel() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
