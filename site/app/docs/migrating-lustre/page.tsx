// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Migrating from Lustre",
  description:
    "Run a Lustre (Gleam) web app on denext with its Gleam source unchanged: detection, what migrate generates, and what migrate --check reports.",
};

export default async function MigratingLustre() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
