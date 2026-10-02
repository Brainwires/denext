// Authored in Markdown — see ./content.md. The page is a thin wrapper that
// renders the Markdown file through the docs shell at build/export time.
import { MarkdownDoc } from "../../../components/markdown.tsx";

export const metadata = {
  title: "Doctor, audit & info",
  description:
    "denext doctor renders every route and checks the project; denext audit inventories dependencies and proves the zero-npm runtime with a CycloneDX SBOM.",
};

export default async function DoctorAudit() {
  return await MarkdownDoc({ url: new URL("./content.md", import.meta.url) });
}
