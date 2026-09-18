// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Multi-instance deployments",
  description:
    "Every per-node component — CacheStore, SessionStore, RateLimitStore, AuthAdapter, ChannelTransport, the cron scheduler, task history — with its interface, what breaks across replicas, and how to share it.",
};

export default async function MultiInstance() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
