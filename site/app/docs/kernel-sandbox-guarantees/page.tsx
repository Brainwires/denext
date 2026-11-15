// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox guarantee matrix",
  description:
    "In development for denext 4.20: per permission, platform, Linux kernel and mode, whether the kernel sandbox enforces a rule exactly, more coarsely, or leaves it to Deno's checks, and what counts as a vulnerability.",
};

export default async function KernelSandboxGuarantees() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("guarantees"),
  });
}
