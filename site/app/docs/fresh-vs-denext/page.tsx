// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Fresh and denext",
  description:
    "What Fresh does and where each part lives on denext, what denext adds (typed API, Live, auth, backend, desktop and mobile targets), where the two differ, and what moving costs.",
};

export default async function FreshVsDenext() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
