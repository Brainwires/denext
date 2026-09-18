// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Production checklist",
  description:
    "The go-live list: what denext already does out of the box, and every key, flag and environment variable you still decide — secrets, proxy origin, permissions, limits, headers, observability, supply chain, multi-instance.",
};

export default async function ProductionChecklist() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
