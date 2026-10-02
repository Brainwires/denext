// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Migrating from Remix",
  description:
    "denext migrate converts a Remix (or React Router v7 framework-mode) app to denext conventions and keeps its loaders, actions, and hooks running on the denext/remix runtime.",
};

export default async function MigratingRemix() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
