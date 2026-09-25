// `deno task ota:serve`: export the UI to out/ and serve it to the app's OTA check on the
// LAN (http://<this machine's LAN IP>:8787). Set DENEXT_OTA_SIGNING_KEY to the private key's
// PEM first: the app embeds the matching public key and refuses an unsigned manifest.
import { createOtaHandler } from "denext/server";

const exported = await new Deno.Command(Deno.execPath(), {
  args: ["task", "export"],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!exported.success) Deno.exit(1);

const ota = createOtaHandler({ dir: "out", cors: true });
Deno.serve({ hostname: "0.0.0.0", port: 8787 }, async (req) => {
  console.log(req.method, new URL(req.url).pathname);
  return (await ota(req)) ?? new Response("Not Found", { status: 404 });
});
