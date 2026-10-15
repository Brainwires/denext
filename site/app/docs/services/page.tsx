// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Supervised services",
  description:
    "supervise() and defineService(): long-lived server work restarted with backoff, escalated past a restart intensity, stopped in reverse order on the server drain. Restart semantics, not process isolation.",
};

export default async function Services() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
