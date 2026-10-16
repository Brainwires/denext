// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Model–View–Update",
  description:
    "denext/mvu: useMvu(init, update, subscriptions) with effects as data (fetch, delay, task, channel), MvuView for a whole program, and DevTools time travel.",
};

export default async function Mvu() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
