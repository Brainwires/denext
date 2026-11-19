// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox warn mode",
  description:
    "What --kernel-sandbox=warn reports: every access the kernel sandbox would refuse under enforce, who made it, and the grant that would allow it, without refusing anything. The sources, the output, the JSON-lines log and what each platform can see.",
};

export default async function KernelSandboxWarn() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("warn"),
  });
}
