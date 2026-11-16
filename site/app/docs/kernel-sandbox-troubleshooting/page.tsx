// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox troubleshooting",
  description:
    "In development (an opt-in preview in denext 4.20, the full sandbox in 5.0): telling whether the kernel sandbox refused something, turning it down safely, and fixes for common symptoms.",
};

export default async function KernelSandboxTroubleshooting() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("troubleshooting"),
  });
}
