// `appLinks` (src/server/app-links.ts): the config validation, the apple-app-site-association
// and assetlinks.json documents, the handler, and the request pipeline answering them before
// basePath / trailingSlash / redirects (iOS and Android refuse a redirected answer).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  appleAppSiteAssociation,
  appLinkFiles,
  assetLinks,
  createAppLinksHandler,
  normalizeCertFingerprint,
  validateAppLinks,
} from "../src/server/app-links.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import type { AppLinksConfig } from "../src/server/config.ts";
import { createApp } from "../src/server/app.ts";
import type { RouteManifest } from "../src/router/manifest.ts";

const FP =
  "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";

const CONFIG: AppLinksConfig = {
  apple: { appIds: ["ABCDE12345.com.example.app"], paths: ["/orders/*", "!/admin/*"] },
  android: { packageName: "com.example.app", sha256CertFingerprints: [FP.toLowerCase()] },
};

/** Every problem `validateAppLinks` reports for `value`. */
function problems(value: unknown): string[] {
  const out: string[] = [];
  validateAppLinks(value, (path, msg) => void out.push(`${path}: ${msg}`));
  return out;
}

Deno.test("validateAppLinks: accepts a good config, names each bad field", () => {
  assertEquals(problems(undefined), []);
  assertEquals(problems(CONFIG), []);
  assertEquals(problems([]).length, 1);
  const bad = problems({
    apple: { appIds: ["com.example.app"], paths: ["orders"], webcredentials: "yes" },
    android: { packageName: "app", sha256CertFingerprints: ["xyz"], loginCredentials: 1 },
  });
  assertEquals(bad.map((p) => p.split(":")[0]), [
    "appLinks.apple.appIds",
    "appLinks.apple.paths",
    "appLinks.apple.webcredentials",
    "appLinks.android.packageName",
    "appLinks.android.sha256CertFingerprints",
    "appLinks.android.loginCredentials",
  ]);
  assertEquals(problems({ apple: { appIds: [] }, android: {} }).length, 3);
  assertThrows(
    () => validateDenextConfig({ appLinks: { apple: { appIds: ["x"] } } } as never),
    Error,
    "appLinks.apple.appIds",
  );
  validateDenextConfig({ appLinks: CONFIG });
});

Deno.test("normalizeCertFingerprint: colon form, upper case; plain hex accepted", () => {
  assertEquals(normalizeCertFingerprint(FP.toLowerCase()), FP);
  assertEquals(normalizeCertFingerprint(FP.replaceAll(":", "")), FP);
  assertEquals(normalizeCertFingerprint("AB:CD"), null);
});

Deno.test("the documents: components with excludes, webcredentials, login creds", () => {
  assertEquals(appleAppSiteAssociation(CONFIG.apple!), {
    applinks: {
      details: [{
        appIDs: ["ABCDE12345.com.example.app"],
        components: [{ "/": "/orders/*" }, { "/": "/admin/*", exclude: true }],
      }],
    },
    webcredentials: { apps: ["ABCDE12345.com.example.app"] },
  });
  assertEquals(
    appleAppSiteAssociation({ appIds: ["ABCDE12345.a.b"], webcredentials: false }),
    { applinks: { details: [{ appIDs: ["ABCDE12345.a.b"], components: [{ "/": "*" }] }] } },
  );
  assertEquals(assetLinks(CONFIG.android!), [{
    relation: [
      "delegate_permission/common.handle_all_urls",
      "delegate_permission/common.get_login_creds",
    ],
    target: {
      namespace: "android_app",
      package_name: "com.example.app",
      sha256_cert_fingerprints: [FP],
    },
  }]);
  assertEquals(
    assetLinks({ ...CONFIG.android!, loginCredentials: false })[0].relation,
    ["delegate_permission/common.handle_all_urls"],
  );
  assertEquals([...appLinkFiles(undefined).keys()], []);
  assertEquals([...appLinkFiles({ android: CONFIG.android }).keys()], [
    "/.well-known/assetlinks.json",
  ]);
});

Deno.test("createAppLinksHandler: 200 application/json for GET/HEAD of the two paths only", async () => {
  const handle = createAppLinksHandler(CONFIG);
  const aasa = handle(new Request("https://x/.well-known/apple-app-site-association"))!;
  assertEquals(aasa.status, 200);
  assertEquals(aasa.headers.get("content-type"), "application/json");
  assertEquals((await aasa.json()).applinks.details[0].appIDs, CONFIG.apple!.appIds);
  const head = handle(new Request("https://x/.well-known/assetlinks.json", { method: "HEAD" }))!;
  assertEquals([head.status, head.body], [200, null]);
  assertEquals(
    handle(new Request("https://x/.well-known/assetlinks.json", { method: "POST" })),
    null,
  );
  assertEquals(handle(new Request("https://x/.well-known/apple-app-site-association.json")), null);
  assertEquals(
    createAppLinksHandler(undefined)(new Request("https://x/.well-known/assetlinks.json")),
    null,
  );
});

Deno.test("createApp: answers before basePath, trailingSlash and redirects", async () => {
  const manifest = { pages: [], apis: [], metadata: [] } as unknown as RouteManifest;
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({}),
    basePath: "/app",
    trailingSlash: true,
    redirects: [{ source: "/.well-known/:path*", destination: "/elsewhere", permanent: true }],
    appLinks: CONFIG,
  } as never);
  const res = await app(new Request("https://example.com/.well-known/apple-app-site-association"));
  assertEquals(res.status, 200);
  assert(!res.headers.has("location"));
  assertEquals(res.headers.get("content-type"), "application/json");
  const links = await app(new Request("https://example.com/.well-known/assetlinks.json"));
  assertEquals((await links.json())[0].target.package_name, "com.example.app");
});
