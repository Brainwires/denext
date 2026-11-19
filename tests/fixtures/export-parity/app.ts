// The `output: "export"` parity fixture: one App Router app, written once and exported by both
// Next.js (`next build` with `output: "export"`, scripts/export-parity-snapshot.ts) and denext
// (`denext export` in compat mode, tests/e2e/next-compat-export-parity.test.ts), so the set of
// files each writes to `out/` can be compared. It covers the conventions a static export turns
// into files: pages, the root not-found, a dynamic route with generateStaticParams, force-static
// route handlers, metadata files (sitemap, robots, favicon, icon, opengraph-image), next/image
// (unoptimized) and the `trailingSlash` / `basePath` variants.

import { join } from "@std/path";
import { samplePng } from "../sample-image.ts";

/** The Next.js release the snapshots were taken with. */
export const NEXT_VERSION = "16.4.6";
/** The React release Next ran with. */
export const REACT_VERSION = "19.2.9";

/** One exported configuration. */
export interface ParityVariant {
  /** Snapshot file stem. */
  name: string;
  trailingSlash?: boolean;
  basePath?: string;
}

/** The variants the parity check exports. */
export const VARIANTS: ParityVariant[] = [
  { name: "default" },
  { name: "trailing-slash", trailingSlash: true },
  { name: "base-path", basePath: "/docs" },
];

const SOURCES: Record<string, string> = {
  "app/layout.tsx": `import { createElement as h } from "react";
export const metadata = { title: "Parity", description: "export parity fixture" };
export default function RootLayout({ children }: { children: unknown }) {
  return h("html", { lang: "en" }, h("body", null, children as never));
}
`,
  "app/page.tsx": `import { createElement as h } from "react";
import Link from "next/link";
import Image from "next/image";
export default function Home() {
  return h("main", null,
    h("h1", null, "PARITY_HOME"),
    h(Image, { src: "/pic.png", alt: "pic", width: 16, height: 16 }),
    h(Link, { href: "/about" }, "about"),
    h(Link, { href: "/blog/first" }, "first"));
}
`,
  "app/about/page.tsx": `import { createElement as h } from "react";
export const metadata = { title: "About" };
export default function About() {
  return h("main", null, "PARITY_ABOUT");
}
`,
  "app/not-found.tsx": `import { createElement as h } from "react";
export default function NotFound() {
  return h("main", null, h("h2", null, "PARITY_NOT_FOUND"));
}
`,
  "app/blog/[slug]/page.tsx": `import { createElement as h } from "react";
export function generateStaticParams() {
  return [{ slug: "first" }, { slug: "second" }];
}
export default async function Post({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return h("article", null, "PARITY_POST:" + slug);
}
`,
  "app/api/hello/route.ts": `export const dynamic = "force-static";
export function GET() {
  return Response.json({ hello: "parity" });
}
`,
  "app/data.json/route.ts": `export const dynamic = "force-static";
export function GET() {
  return Response.json({ items: [1, 2, 3] });
}
`,
  "app/feed.xml/route.ts": `export const dynamic = "force-static";
export function GET() {
  return new Response("<rss version=\\"2.0\\"></rss>", {
    headers: { "content-type": "application/rss+xml" },
  });
}
`,
  "app/sitemap.ts": `export const dynamic = "force-static";
export default function sitemap() {
  return [{ url: "https://parity.example/" }, { url: "https://parity.example/about" }];
}
`,
  "app/robots.ts": `export const dynamic = "force-static";
export default function robots() {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: "https://parity.example/sitemap.xml" };
}
`,
};

/** Binary files: the metadata images, and a public image next/image renders. */
const BINARIES: Record<string, () => Uint8Array> = {
  "app/favicon.ico": samplePng,
  "app/icon.png": samplePng,
  "app/opengraph-image.png": samplePng,
  "public/pic.png": samplePng,
};

/**
 * Write the fixture app for `target` into `dir`: the shared sources, plus Next's package.json +
 * next.config.mjs, or denext's deno.json + denext.config.ts (compat mode, so `react` / `next/*`
 * resolve to denext with the source unchanged).
 */
export async function writeParityApp(
  dir: string,
  variant: ParityVariant,
  target: "next" | "denext",
): Promise<void> {
  const write = async (name: string, data: string | Uint8Array) => {
    await Deno.mkdir(join(dir, name, ".."), { recursive: true });
    if (typeof data === "string") await Deno.writeTextFile(join(dir, name), data);
    else await Deno.writeFile(join(dir, name), data);
  };
  for (const [name, src] of Object.entries(SOURCES)) await write(name, src);
  for (const [name, bytes] of Object.entries(BINARIES)) await write(name, bytes());
  const options = {
    ...(variant.trailingSlash ? { trailingSlash: true } : {}),
    ...(variant.basePath ? { basePath: variant.basePath } : {}),
  };
  if (target === "next") {
    await write(
      "package.json",
      JSON.stringify(
        {
          private: true,
          dependencies: {
            next: NEXT_VERSION,
            react: REACT_VERSION,
            "react-dom": REACT_VERSION,
          },
          // Next refuses to build TypeScript sources without them (types are not checked).
          devDependencies: {
            typescript: "5.9.3",
            "@types/react": "19.2.18",
            "@types/node": "22.20.5",
          },
        },
        null,
        2,
      ),
    );
    const config = {
      output: "export",
      images: { unoptimized: true },
      // No TypeScript install: the fixture's types are not what the snapshot records.
      typescript: { ignoreBuildErrors: true },
      ...options,
    };
    await write("next.config.mjs", `export default ${JSON.stringify(config)};\n`);
    return;
  }
  await write("deno.json", JSON.stringify({ nodeModulesDir: "auto", imports: {} }));
  const config = { compatibilityMode: true, images: { unoptimized: true }, ...options };
  await write("denext.config.ts", `export default ${JSON.stringify(config)};\n`);
}

/** Every file under `dir`, relative, `/`-separated, sorted. */
export async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) out.push(...await listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * The files of an export that the parity check compares: everything but each framework's own
 * client-asset tree (`_next/`, `_denext/`), whose names are content hashes.
 */
export function comparableFiles(files: string[]): string[] {
  return files.filter((f) => !f.startsWith("_next/") && !f.startsWith("_denext/"));
}
