// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Environment variables",
  description:
    ".env tiers by mode, the shell-wins rule, NEXT_PUBLIC_/DENEXT_PUBLIC_ and publicEnv(), validating required variables at boot, and every DENEXT_* variable the framework reads.",
};

export default async function Environment() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
