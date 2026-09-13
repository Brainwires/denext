// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Troubleshooting",
  description:
    "Symptom → cause → fix for the errors people actually hit, each pointing at the page that owns the detail.",
};

export default async function Troubleshooting() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
