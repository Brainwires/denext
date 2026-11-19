// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox: doctor and dry run",
  description:
    "denext doctor and denext kernel-sandbox: which kernel features this machine has, what the sandbox does for the project, and a dry run of the start grant that runs nothing of the app.",
};

export default async function KernelSandboxDoctor() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("doctor"),
  });
}
