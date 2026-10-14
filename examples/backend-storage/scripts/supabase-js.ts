// The same storage from the stock supabase-js client: `createClient(appUrl, key)` and
// `supabase.storage`, unchanged. Start the app (`denext task dev`), then:
//
//   deno task supabase-js
//
// The keys come from `backend({ supabase: true })`'s dev key set (.denext/backend-keys.json);
// the secret key is the service role, so this script may manage buckets.

import { createClient } from "@supabase/supabase-js";

const url = Deno.env.get("APP_URL") ?? "http://localhost:3000";
const keys = JSON.parse(
  await Deno.readTextFile(".denext/backend-keys.json"),
) as {
  publishableKey: string;
  secretKey: string;
};
const admin = createClient(url, keys.secretKey, {
  auth: { persistSession: false },
});

const { data: buckets } = await admin.storage.listBuckets();
console.log("buckets:", buckets?.map((b) => b.name));

const docs = admin.storage.from("documents");
await docs.upload("hello.txt", "Hello from supabase-js", {
  contentType: "text/plain",
  upsert: true,
});
const { data: listed } = await docs.list("", { limit: 10 });
console.log("documents:", listed?.map((f) => f.name));
const { data: signed } = await docs.createSignedUrl("hello.txt", 60);
console.log("signed URL:", signed?.signedUrl);

// The versioned bucket: every save is kept.
const notes = admin.storage.from("notes");
await notes.upload("note.txt", `saved at ${new Date().toISOString()}`, {
  contentType: "text/plain",
  upsert: true,
});
const { data: versions } = await notes.list("", {
  noncurrentVersions: "include",
});
console.log("note versions:", versions?.map((v) => [v.version, v.archived_at]));

// listV2: cursor pages.
const { data: page } = await docs.listV2({ limit: 5 });
console.log("listV2:", page?.objects.map((o) => o.key), "more:", page?.hasNext);
