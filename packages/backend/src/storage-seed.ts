// `denext db seed`'s storage half (the Supabase CLI's `seed buckets`): create the buckets the
// config declares, then upload each `supabase/buckets/<bucket>/**` file as `<bucket>/<path>`
// (replacing what is there), through the server API as the service role.

import { extname, join, relative } from "@std/path";
import { filesUnder } from "./files.ts";
import { storage } from "./storage.ts";

/** Content types by extension, for the files a seed directory usually holds. */
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/**
 * The content type a seed file is uploaded with (by extension; unknown ones are sniffed).
 *
 * @param path The file.
 * @returns The type, or `undefined`.
 */
export function seedContentType(path: string): string | undefined {
  return TYPES[extname(path).toLowerCase()];
}

/** Upload one seed file as `<bucket>/<key>`; returns what happened (nothing for a loose file). */
async function seedObject(
  file: string,
  [bucket, ...rest]: string[],
  buckets: Set<string>,
): Promise<string | undefined> {
  if (!rest.length) return undefined;
  const key = rest.join("/");
  if (!buckets.has(bucket)) return `skipped ${bucket}/${key} (no bucket ${bucket})`;
  const type = seedContentType(file);
  await storage.bucket(bucket, { service: true }).upload(key, await Deno.readFile(file), {
    upsert: true,
    ...(type ? { contentType: type } : {}),
  });
  return `uploaded ${bucket}/${key}`;
}

/**
 * Create the config's buckets and upload their seed objects.
 *
 * @param projectDir The project.
 * @returns A line per bucket and per uploaded object.
 */
export async function seedBuckets(projectDir: string): Promise<string[]> {
  const lines: string[] = [];
  // Listing seeds the config-declared buckets into the bucket table first.
  const buckets = new Set((await storage.listBuckets({ service: true })).map((b) => b.name));
  for (const name of [...buckets].sort()) lines.push(`bucket ${name}`);
  const root = join(projectDir, "supabase", "buckets");
  for (const file of await filesUnder(root)) {
    const line = await seedObject(file, relative(root, file).split(/[\\/]/), buckets);
    if (line) lines.push(line);
  }
  return lines;
}
