// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Client Components",
  description:
    '"use client" boundaries, useOptimistic / useFormStatus / useTransition, dynamic() and lazy(), portals, context providers in the root layout, and the SSR-safe utility hooks.',
};

export default async function ClientComponents() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
