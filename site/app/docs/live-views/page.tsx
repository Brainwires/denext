// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Live views",
  description:
    "defineLiveView: a Model–View–Update program held on the server per Live connection — HTML first paint, events over the socket, Flight-diff DOM patches, resume on reconnect.",
};

export default async function LiveViews() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
