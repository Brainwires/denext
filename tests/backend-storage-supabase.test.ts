// The real `@supabase/supabase-js` (and `tus-js-client`) against `@denext/backend` storage on the
// fs driver, with the sqlite metadata store and TypeScript `authorize` rules: buckets, uploads,
// listings, signed URLs and uploads, copy and move, public URLs and image transforms, per-user
// rules, removal, and TUS resumable uploads. The same suite runs on MinIO + Postgres with SQL-RLS
// policies in tests/backend-storage-supabase-integration.test.ts.

import { backend, fs } from "../packages/backend/mod.ts";
import {
  runSupabaseStorageSuite,
  storageHarness,
  supabaseKeys,
} from "./helpers/supabase-storage-suite.ts";

Deno.test({
  name: "supabase-js storage on the fs driver (sqlite metadata, TypeScript rules)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const h = await storageHarness(backend({
      supabase: await supabaseKeys(),
      storage: {
        secret: "storage-secret-at-least-32-characters",
        driver: fs({ dir: ".storage" }),
        buckets: {
          private: {
            authorize: ({ identity, key }) =>
              identity.role === "authenticated" && key.startsWith(`${identity.userId}/`),
          },
          images: { public: true, mime: ["image/png"], maxBytes: 64 * 1024 },
        },
      },
    }));
    try {
      await runSupabaseStorageSuite(t, h);
    } finally {
      await h.close();
    }
  },
});
