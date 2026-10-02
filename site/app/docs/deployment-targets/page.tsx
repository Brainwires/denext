// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Deployment targets",
  description:
    "Docker, Deno Deploy, systemd, Fly.io, Railway, Kubernetes and static hosts in one table with a stanza each; why Cloudflare Workers and Vercel are not targets; zero-downtime restarts and the drain deadline; what deno compile does and does not give you.",
};

export default async function DeploymentTargets() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
