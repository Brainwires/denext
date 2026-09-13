// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Migrating from Next.js",
  description:
    "If you know the App Router, you already know denext. The conventions are the same; the runtime underneath is Deno with its own small React.",
};

export default async function Migrating() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
