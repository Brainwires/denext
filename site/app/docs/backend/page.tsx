// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Backend",
  description:
    "@denext/backend: backend services inside your app as one opt-in plugin. Storage: buckets with rules, signed upload and download URLs, multipart uploads, image transforms, on S3, R2, MinIO or the filesystem.",
};

export default async function Backend() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
