// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Permissions",
  description:
    "Deno's --allow-* flags under denext are least-privilege guardrails, not a sandbox: the grants that mean full trust, the ones that expose secrets or credentials, symlinks and allow scopes, and how network rules behave with a proxy.",
};

export default async function Permissions() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
