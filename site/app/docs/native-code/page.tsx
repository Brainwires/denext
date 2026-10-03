// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Your own native code",
  description:
    "Capacitor plugins and desktop extensions as your native modules: nativeModule, denext mobile add native-module, and TurboModules / Expo Modules in React Native mode.",
};

export default async function NativeCode() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
