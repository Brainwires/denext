// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Tutorial",
  description:
    "Build the repository's examples/notes app step by step — SQLite, Server Components, a no-JS Server Action form, sessions, ISR, tests, a client island, and a build.",
};

export default async function Tutorial() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
