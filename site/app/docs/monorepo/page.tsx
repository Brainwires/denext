// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Monorepos",
  description:
    "denext create --monorepo: a Deno workspace with an app in apps/web and shared packages it imports by name, in Server Components, islands and the client bundle alike.",
};

export default async function Monorepo() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
