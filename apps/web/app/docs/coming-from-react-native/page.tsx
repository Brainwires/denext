// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Coming from React Native",
  description:
    "A concept map for React Native and Expo developers: what each React Native / Expo concept maps to in denext and its Capacitor shell, what a WebView changes, and when to stay on React Native.",
};

export default async function ComingFromReactNative() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
