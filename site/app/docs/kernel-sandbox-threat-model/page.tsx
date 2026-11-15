// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox threat model",
  description:
    "In development (an opt-in preview in denext 4.20, the full sandbox in 5.0): the attacker the kernel sandbox assumes, what it protects, what is out of scope, and how to report a sandbox escape.",
};

export default async function KernelSandboxThreatModel() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("threat-model"),
  });
}
