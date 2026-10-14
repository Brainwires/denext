// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Upgrading to 4.0",
  description:
    "Moving a denext 3.x app to 4.0: the pins and plugin releases, tasks renamed to jobs, the CLI on denext's Deno toolchain, per-address limits, esbuild and the backend changes.",
};

export default async function Upgrading() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
