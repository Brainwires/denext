// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Migrating from Preact",
  description:
    "Run a Preact app (Vite with @preact/preset-vite, preact-cli, WMR or esbuild) on denext as a SPA: detection, the Preact and preact-iso aliases, and what migrate --check reports.",
};

export default async function MigratingPreact() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
