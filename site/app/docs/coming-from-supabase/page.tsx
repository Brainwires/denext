// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Coming from Supabase",
  description:
    "A concept map and migration checklist for Supabase developers: what each Supabase feature maps to in denext and @denext/backend, how queries, auth, storage, realtime and edge functions translate, how to move a project's schema, policies, users and files, and what is not there yet.",
};

export default async function ComingFromSupabase() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
