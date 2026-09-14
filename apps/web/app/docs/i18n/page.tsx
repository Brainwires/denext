// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Internationalization",
  description:
    "Locale routing with a default-locale prefix, locale negotiation, automatic hreflang, and the next-intl compat surface with its ICU subset.",
};

export default async function I18n() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
