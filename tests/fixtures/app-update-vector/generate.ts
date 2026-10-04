// Regenerate the cross-language full-app update vector: a manifest signed by denext's own signer
// (`signAppUpdatePayload`, WebCrypto ECDSA P-256), verified by the Deno Desktop runtime's Rust test
// (`runtime/ops/desktop_update/manifest.rs`, testdata/webcrypto_vector.*) and by
// tests/desktop-app-update.test.ts. Run: deno run -A tests/fixtures/app-update-vector/generate.ts,
// then copy both files to the runtime's testdata (the two must stay byte-identical).
import { generateOtaKeyPair, importOtaSigningKey } from "../../../src/build/ota-signing.ts";
import { signAppUpdatePayload } from "../../../src/build/app-update.ts";

const dir = new URL(".", import.meta.url);
const pair = await generateOtaKeyPair();
const envelope = await signAppUpdatePayload({
  schema: 1,
  app: "com.example.vector",
  version: "1.2.3",
  platforms: {
    "x86_64-unknown-linux-gnu-webview": {
      url: "https://example.com/a.tar.gz",
      sha256: "0".repeat(64),
      size: 4242,
      kind: "bundle",
    },
  },
  releaseNotes: "Grüße ✓",
  publishedAt: "2026-10-01T00:00:00Z",
  expiresAt: "2026-10-15T00:00:00.000Z",
  sequence: 1790812800,
}, await importOtaSigningKey(pair.privateKeyPem));
await Deno.writeTextFile(new URL("webcrypto_vector.pub", dir), pair.publicKey);
await Deno.writeTextFile(new URL("webcrypto_vector.json", dir), JSON.stringify(envelope));
