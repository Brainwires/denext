// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Native-feel navigation",
  description:
    "StackLayout, TabsLayout and Sheet from denext/navigation: kept screens, platform push and pop animations, the iOS swipe-back, Android predictive back, tabs that keep their stacks, bottom sheets, and React Navigation / Expo Router in React Native mode.",
};

export default async function NavigationNative() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
