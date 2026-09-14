// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Pages Router",
  description:
    "The full Next.js Pages Router as an opt-in plugin: pages/ routing, data fetching, _app and _document, API routes, useRouter, i18n and Preview Mode.",
};

export default async function PagesRouter() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
