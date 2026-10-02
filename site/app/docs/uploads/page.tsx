// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "File uploads",
  description:
    "A File through a Server Action, a route handler with request.formData() or a streamed body, an XHR upload with progress, and the body caps that apply to each.",
};

export default async function Uploads() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
