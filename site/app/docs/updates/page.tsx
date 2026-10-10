// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Updates everywhere",
  description:
    "denext/updates: one checkForUpdates / applyUpdates for phones (over-the-air UI), Deno Desktop (the UI overlay and the full app) and the web (a reload), with one progress shape.",
};

export default async function Updates() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
