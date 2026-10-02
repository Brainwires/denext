// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Lists & scrolling",
  description:
    "VirtualList and useVirtualList: 10M-row lists, chat anchoring, sticky sections, grids, masonry, tables, reorder, pull-to-refresh, viewability, SSR and iOS-momentum-safe scrolling.",
};

export default async function Lists() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
