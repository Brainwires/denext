// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "The Deno Desktop runtime",
  description:
    "How denext ships Deno Desktop at Electron parity: a prebuilt runtime from public forks, pinned by SHA-256, attested, and retired as the work lands upstream.",
};

export default async function DesktopRuntime() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
