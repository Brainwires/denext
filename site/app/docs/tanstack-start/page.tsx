// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "TanStack Start",
  description:
    "Run a TanStack Start app on denext with the @denext/tanstack-start plugin: setup, migration, server functions, import protection, prerender and every option.",
};

export default async function TanstackStart() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
