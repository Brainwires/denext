// Authored in Markdown — see ./content.md, generated from catalog/fixed-in-denext.json by
// `deno task docs:fixed`. The page renders the Markdown file through the docs shell.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Fixed in denext",
  description:
    "Problems people hit on Next.js, React, Vite and React Native stacks that denext handles, each backed by a named test.",
};

export default async function Fixed() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
