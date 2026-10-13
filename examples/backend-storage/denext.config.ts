import type { DenextConfig } from "denext/server";
import { backend, fs, s3 } from "@denext/backend";

// S3 when the environment names a bucket (AWS, Cloudflare R2, MinIO …), the local filesystem
// otherwise. Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
const bucket = Deno.env.get("S3_BUCKET");
const driver = bucket
  ? s3({
    bucket,
    region: Deno.env.get("S3_REGION") ?? "us-east-1",
    endpoint: Deno.env.get("S3_ENDPOINT"), // e.g. http://127.0.0.1:9000 for MinIO
  })
  : fs({ dir: ".storage" });

export default {
  plugins: [
    backend({
      // Supabase-compatible API keys (`denext dev` generates a set in .denext/backend-keys.json),
      // so the stock supabase-js client works against /storage/v1 — see scripts/supabase-js.ts.
      supabase: true,
      storage: {
        driver,
        // Signs this app's storage URLs. Set DENEXT_STORAGE_SECRET (≥ 32 characters) in
        // production; `denext dev` falls back to a random per-run secret.
        buckets: {
          // Anyone may read; this demo has no sign-in, so it lets anyone upload images too.
          // A real app checks `session` here (`denextAuth`): `!!session && key.startsWith(…)`.
          gallery: {
            public: true,
            maxBytes: 5 * 1024 * 1024,
            mime: ["image/png", "image/jpeg", "image/webp", "image/gif"],
            authorize: ({ op }) => op === "upload" || op === "list",
          },
          // Private: every download is a signed URL that expires. Large files go up resumably
          // (TUS), in chunks that survive a dropped connection.
          documents: {
            maxBytes: 200 * 1024 * 1024,
            mime: ["application/pdf", "text/plain"],
            authorize: ({ op }) => op !== "delete",
          },
          // Versioned: saving a note keeps the old text as a noncurrent version.
          notes: {
            versioned: true,
            mime: ["text/plain"],
            maxBytes: 64 * 1024,
            authorize: () => true,
          },
        },
      },
    }),
  ],
} satisfies DenextConfig;
