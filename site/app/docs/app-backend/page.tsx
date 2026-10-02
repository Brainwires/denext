// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "App backend",
  description:
    "Calling your denext server from a Capacitor app: CORS for app origins, native sessions, the remote API client, account deletion and native Apple / Google sign-in.",
};

export default async function AppBackend() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
