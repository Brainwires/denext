// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Architecture",
  description:
    "How denext differs underneath the React surface — its own reconciler, an async-only SSR renderer, concurrency, soft navigation, and request-scoped cache.",
};

export default async function Architecture() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
