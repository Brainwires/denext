// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Writing a plugin",
  description:
    "The denext plugin contract: the six seams, rendering from the public exports, rules & guarantees, and the three stability tiers.",
};

export default async function Plugins() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
