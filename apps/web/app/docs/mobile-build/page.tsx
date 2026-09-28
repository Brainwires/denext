// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Mobile builds & store submission",
  description:
    "denext mobile assets, build and submit: every icon and splash from one image, signed .ipa / .aab / .apk builds with flavors, and App Store Connect / Google Play uploads with dry runs, locally or in CI.",
};

export default async function MobileBuild() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
