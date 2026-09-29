// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "denext vs React Native",
  description:
    "Who should build a phone app on denext and a Capacitor shell and who should stay on React Native: startup, size and memory against a React Native build, what ran on an iPhone, the WebView's inherent limits, and what migrating costs.",
};

export default async function VsReactNative() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
