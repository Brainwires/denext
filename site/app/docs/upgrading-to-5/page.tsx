// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Upgrading to 5.0",
  description:
    "Move a denext 4.x project to 5.0: the auth layer is its own package, @denext/auth, and denext upgrade rewrites the imports, the import map and the next-auth aliases.",
};

export default async function UpgradingTo5() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
