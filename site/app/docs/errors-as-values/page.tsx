// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Errors as values",
  description:
    "denext/result: Result, ok / err, tryAsync, an exhaustive match() over unions, err() from defineApi and defineAction, and the opt-in exhaustive-switch / no-throw lint rules.",
};

export default async function ErrorsAsValues() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
