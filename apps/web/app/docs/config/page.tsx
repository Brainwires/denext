// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Configuration",
  description:
    "Every field of denext.config.ts — routing, rendering mode, images, caching, security, compatibility, plugins, and experimental features.",
};

export default async function Config() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
