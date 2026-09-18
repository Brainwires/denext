// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Route handler recipes",
  description:
    "Webhooks with signature verification, Server-Sent Events and long AI streams past the request deadline, a WebSocket upgrade in a route handler, CORS preflight by hand, and when Live channels are the better tool.",
};

export default async function RouteHandlerRecipes() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
