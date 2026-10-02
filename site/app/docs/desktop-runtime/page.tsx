// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Our Deno Desktop runtime: what we ship and why",
  description:
    "Every change in denext's Deno Desktop runtime and the problem it solves: a prebuilt runtime from public forks of Deno and laufey, tested on every OS, pinned by SHA-256, attested, and retired as the work lands upstream.",
};

export default async function DesktopRuntime() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
