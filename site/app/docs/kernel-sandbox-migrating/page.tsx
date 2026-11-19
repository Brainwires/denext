// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Preparing an app for kernel enforcement",
  description:
    "The upgrade guide for apps whose runs become kernel-enforced: find what would be refused with denext kernel-sandbox check, add the grants, choose a mode, and the switches that turn enforcement down.",
};

export default async function KernelSandboxMigrating() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("migrating"),
  });
}
