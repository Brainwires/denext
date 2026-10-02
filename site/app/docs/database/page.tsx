// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Databases",
  description:
    "Any database that runs on Deno runs on denext — node:sqlite and Deno KV are built in and zero-npm, and Drizzle and Prisma are verified recipes.",
};

export default async function Database() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
