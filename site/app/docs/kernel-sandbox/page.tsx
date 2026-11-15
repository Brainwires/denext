// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";
import { kernelSandboxNav } from "../../../lib/kernel-sandbox.ts";

export const metadata = {
  title: "Kernel sandbox",
  description:
    "Kernel-enforced permissions for denext's Deno (in development for denext 4.20): Landlock and seccomp on Linux, Seatbelt on macOS, a job object on Windows and a supervisor for finer rules hold a fixed --allow-* grant against FFI, Node-API addons, native npm code and subprocesses.",
};

export default async function KernelSandbox() {
  return await MarkdownDoc({
    url: new URL("./content.md", import.meta.url),
    navChildren: kernelSandboxNav(),
  });
}
