// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Preact Signals (denext/signals)",
  description:
    "denext/signals is Preact Signals' API on denext: signal, computed, effect, batch, the component hooks, Show and For, and signals passed from a Server Component.",
};

export default async function Signals() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
