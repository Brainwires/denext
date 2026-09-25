// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "React Native / Expo apps",
  description:
    "Build a React Native or Expo app's source for the web through react-native-web: reactNative in denext.config.ts, the web entry, and a uniwind recipe.",
};

export default async function ReactNative() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
