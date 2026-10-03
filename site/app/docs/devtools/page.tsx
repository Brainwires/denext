// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "DevTools",
  description:
    "A zero-install glass-box panel in every dev page: component tree, named hooks, editor-linked source, render modes, profiler, network, cache, routes, MCP.",
};

export default async function DevTools() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
