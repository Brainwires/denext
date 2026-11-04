// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Runtime reference",
  description:
    "Every API, flag, config key and environment variable denext's Deno runtime adds to Deno 2.9.8: Deno.SQL, Vitest/Jest in deno test, native TypeScript 7, Node.js-style npm, the lifecycle-script jail, resource limits and the Deno Desktop APIs, with the runtime version each arrived in.",
};

export default async function RuntimeReference() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
