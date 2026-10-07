// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Platform-specific files",
  description:
    "BigButton.ios.tsx, .android, .mobile, .macos / .windows / .linux, .desktop and .web: one app, a file per platform where it needs one, resolved per target at build time.",
};

export default async function PlatformFiles() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
