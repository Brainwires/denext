// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Auth",
  description:
    "First-party OAuth 2.0 / OIDC and Credentials auth — zero-npm, secure by default — with a database adapter, roles and bearer API tokens.",
};

export default async function Auth() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
