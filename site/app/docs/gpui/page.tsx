// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Native tree windows (denext/gpui)",
  description:
    "Render React Native primitives into a Deno Desktop window's native tree on the gpui backend, with no web view: what B1 supports, how it plugs into react-reconciler, and its limits.",
};

export default async function Gpui() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
