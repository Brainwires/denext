// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "npm React libraries",
  description:
    "Using Radix, shadcn, lucide-react, react-hook-form, motion or any npm React library in a native denext app: the compat build path, setup, what changes, and the cost.",
};

export default async function NpmReactLibraries() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
