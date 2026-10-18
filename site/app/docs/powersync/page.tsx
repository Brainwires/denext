// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Offline sync and PowerSync",
  description:
    "A local-first app on denext: a SQLite database on the device with openSqlite, synced with a denext backend, and PowerSync's own SDK in a denext app (what runs where, and what openSqlite cannot host).",
};

export default async function PowerSync() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
