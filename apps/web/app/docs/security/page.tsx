// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Security posture",
  description:
    "Every Next.js, React and React-tooling CVE class, mapped to whether denext's reimplementation shares the vulnerable behavior.",
};

export default async function Security() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
