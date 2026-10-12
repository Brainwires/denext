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
          // Private: every download is a signed URL that expires.
          documents: {
            maxBytes: 20 * 1024 * 1024,
            mime: ["application/pdf", "text/plain"],
            authorize: ({ op }) => op !== "delete",
          },
        },
      },
    }),
  ],
} satisfies DenextConfig;
