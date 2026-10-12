import { storage } from "@denext/backend/server";
import { Uploader } from "./uploader.tsx";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Server Components call the server API directly. Listing runs the bucket's `authorize`
  // (op "list") for this request; `createSignedUrl` on a public bucket is a stable URL, and the
  // `transform` resizes each image to a 256 px thumbnail through denext's image pipeline.
  const gallery = storage.bucket("gallery");
  const { objects } = await gallery.list("", { limit: 24 });
  const thumbs = await Promise.all(
    objects.map(async (o) => ({
      key: o.key,
      src: await gallery.createSignedUrl(o.key, { transform: { width: 256 } }),
    })),
  );
  return (
    <main>
      <h1>Storage</h1>
      <p>
        Pick an image: the browser asks <code>/_denext/storage/sign</code>{" "}
        for an upload URL, sends the bytes straight to the store with progress, and the server
        checks what arrived (size, type, the first bytes) before it counts.
      </p>
      <Uploader bucket="gallery" accept="image/*" />
      <div class="grid">
        {thumbs.map((t) => <img key={t.key} src={t.src} alt={t.key} loading="lazy" />)}
      </div>
      <h2>Private documents</h2>
      <p>
        PDFs and text files go to a private bucket; each link is signed and expires in an hour.
      </p>
      <Uploader bucket="documents" accept="application/pdf,text/plain" />
    </main>
  );
}
