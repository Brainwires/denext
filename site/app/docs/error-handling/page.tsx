// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Error handling",
  description:
    "error.tsx and global-error.tsx boundaries, notFound / forbidden / unauthorized, useErrorBoundary, redaction, and request ids.",
};

export default async function ErrorHandling() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
