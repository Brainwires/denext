// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "denext's Deno toolchain",
  description:
    "The denext commands that run project code run on denext's own Deno build (Deno.SQL, Vitest/Jest compat in deno test), downloaded on first need, pinned by SHA-256, never replacing your deno.",
};

export default async function Toolchain() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
