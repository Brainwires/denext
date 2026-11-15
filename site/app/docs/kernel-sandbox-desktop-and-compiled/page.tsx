// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox for desktop and compiled apps",
  description:
    "In development for denext 4.20: the kernel sandbox in compiled binaries and packaged desktop apps, baked modes, desktop.permissions strict, and browser engines.",
};

export default async function KernelSandboxDesktopAndCompiled() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("desktop-and-compiled"),
  });
}
