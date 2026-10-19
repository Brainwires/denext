// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Migrating from Fresh",
  description:
    "Move a Fresh 2 or Fresh 1.x app to denext: what denext migrate generates around your route modules, the denext/fresh runtime, and what migrate --check reports.",
};

export default async function MigratingFresh() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
