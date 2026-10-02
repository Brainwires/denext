// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Upgrading",
  description:
    "The breaking changes and renamed config keys per denext version, as a checklist — what to change when you bump.",
};

export default async function Upgrading() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
