// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time. It is one of the
// kernel-sandbox section's pages, so the sidebar highlights "Kernel sandbox" and nests the
// section's pages under it.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox modes",
  description:
    "In development for denext 4.20: the --kernel-sandbox modes (off, warn, auto, enforce, broker), the deno.json key, the mode deno compile bakes in, the DENO_KERNEL_SANDBOX switch, --kernel-sandbox-report and deno info --json.",
};

export default async function KernelSandboxModes() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    active: "kernel-sandbox",
    navChildren: kernelSandboxNav("modes"),
  });
}
