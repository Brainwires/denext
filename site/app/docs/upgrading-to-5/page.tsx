// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Upgrading to denext 5.0",
  description:
    "denext 5.0 runs only on its own Deno runtime and moves the auth layer into @denext/auth: what breaks, what denext upgrade rewrites, the CI changes and the errors you will see.",
};

export default async function UpgradingTo5() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
