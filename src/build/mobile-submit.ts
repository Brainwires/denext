// `denext mobile submit ios|android`: upload a store build without a hosted service.
//
//   ios      checks the .ipa (a signed Payload/*.app), the App Store Connect API key (a PKCS#8
//            P-256 key that signs an ES256 token), looks the app up by bundle id through the App
//            Store Connect API (read-only), then uploads with `xcrun altool --upload-app` and the
//            same key (no Apple ID, no app-specific password)
//   android  checks the .aab / .apk (a signed bundle), the Play service account (an RS256 key
//            that the token endpoint accepts), then the Google Play Developer API: an edit, the
//            upload, the track release (internal by default), and the commit
//
// `--dry-run` runs every check, and with the network the read-only lookups (App Store Connect:
// the app by bundle id; Play: an edit opened and deleted, never committed), and uploads nothing.
// Key material is read into WebCrypto and never printed, logged or copied (altool needs the key
// under the name AuthKey_<id>.p8: a key file named otherwise is linked into a private temporary
// directory for the upload and removed after).

import { basename, dirname, join } from "@std/path";
import { importKey, signJwt } from "../server/push-send.ts";
import type { BuildArtifact } from "./mobile-build.ts";
import type { BuildCommand, BuildRunner } from "./mobile-build.ts";
import type { MobilePlatform } from "./mobile-flavor.ts";
import { checkArtifact } from "./mobile-artifact.ts";

/**
 * The newest build artifact `denext mobile build` wrote for `platform` (and `flavor`), with its
 * sidecar: store formats only (.ipa, or .aab before .apk).
 *
 * @param outDir The build output directory (`dist/mobile`).
 * @returns The artifact and its sidecar, or null when there is none.
 */
export async function findLatestArtifact(
  outDir: string,
  platform: MobilePlatform,
  flavor?: string,
): Promise<{ path: string; meta: BuildArtifact } | null> {
  const dir = join(outDir, flavor ? `${platform}-${flavor}` : platform);
  const found: { path: string; meta: BuildArtifact }[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name.slice(0, -".json".length));
      try {
        const meta = JSON.parse(await Deno.readTextFile(join(dir, entry.name))) as BuildArtifact;
        if (meta.platform === platform && (await Deno.stat(path)).isFile) {
          found.push({ path, meta });
        }
      } catch { /* not a sidecar, or its artifact is gone */ }
    }
  } catch {
    return null;
  }
  const rank = (a: { path: string; meta: BuildArtifact }) =>
    (a.meta.configuration === "Release" ? 2 : 0) + (a.path.endsWith(".apk") ? 0 : 1);
  found.sort((a, b) => rank(b) - rank(a) || b.meta.builtAt.localeCompare(a.meta.builtAt));
  return found[0] ?? null;
}

/** One line of the submit report. */
export interface SubmitCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** App Store Connect API key coordinates (the key itself stays in its file). */
export interface AscCredentials {
  readonly keyPath: string;
  readonly keyId: string;
  readonly issuerId: string;
}

/**
 * An App Store Connect API token: ES256, `aud` appstoreconnect-v1, valid 20 minutes.
 *
 * @throws {TypeError} When the key file is not a PKCS#8 P-256 key (the message never quotes it).
 */
export async function ascToken(creds: AscCredentials, now: number): Promise<string> {
  const pem = await Deno.readTextFile(creds.keyPath);
  const key = await importKey(pem, basename(creds.keyPath), { name: "ECDSA", namedCurve: "P-256" });
  const iat = Math.floor(now / 1000);
  return await signJwt(
    { alg: "ES256", kid: creds.keyId, typ: "JWT" },
    { iss: creds.issuerId, iat, exp: iat + 1200, aud: "appstoreconnect-v1" },
    key,
    { name: "ECDSA", hash: "SHA-256" },
  );
}

/** A compact error from a failed API response (status and the first error's title / detail). */
async function apiError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    const e = body.errors?.[0] ?? body.error;
    const detail = typeof e === "string"
      ? e
      : e?.detail ?? e?.title ?? e?.message ?? body.error_description;
    if (detail) return `HTTP ${res.status}: ${detail}`;
  } catch { /* not JSON */ }
  return `HTTP ${res.status}`;
}

/**
 * Look an app up by bundle id in App Store Connect (read-only).
 *
 * @returns The app's id and name, or null when the account has no such app.
 * @throws {Error} When the API refuses the token (a wrong key, id or issuer).
 */
async function ascFindApp(
  token: string,
  bundleId: string,
  doFetch: typeof fetch,
): Promise<{ id: string; name: string } | null> {
  const url = `https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=${
    encodeURIComponent(bundleId)
  }&fields[apps]=name,bundleId&limit=1`;
  const res = await doFetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`App Store Connect refused the request (${await apiError(res)})`);
  const body = await res.json() as { data?: { id: string; attributes?: { name?: string } }[] };
  const app = body.data?.[0];
  return app ? { id: app.id, name: app.attributes?.name ?? bundleId } : null;
}

/**
 * The altool upload command. The key is found by altool as `AuthKey_<id>.p8` in
 * `API_PRIVATE_KEYS_DIR`.
 */
function altoolCommand(ipa: string, creds: AscCredentials, keysDir: string): BuildCommand {
  return {
    cmd: "xcrun",
    args: [
      "altool",
      "--upload-app",
      "-f",
      ipa,
      "-t",
      "ios",
      "--apiKey",
      creds.keyId,
      "--apiIssuer",
      creds.issuerId,
    ],
    cwd: dirname(ipa),
    env: { API_PRIVATE_KEYS_DIR: keysDir },
  };
}

/**
 * A directory altool finds the key in, and how to clean it up: the key's own directory when the
 * file is already named `AuthKey_<id>.p8`, else a private temporary directory holding a symlink
 * (a private copy where the OS refuses the link, as Windows does without the symlink privilege;
 * the directory is removed either way).
 */
async function altoolKeysDir(
  creds: AscCredentials,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  if (basename(creds.keyPath) === `AuthKey_${creds.keyId}.p8`) {
    return { dir: dirname(creds.keyPath), cleanup: () => Promise.resolve() };
  }
  const dir = await Deno.makeTempDir({ prefix: "denext_asc_" });
  const cleanup = () => Deno.remove(dir, { recursive: true });
  try {
    await Deno.chmod(dir, 0o700);
    await linkOrCopy(creds.keyPath, join(dir, `AuthKey_${creds.keyId}.p8`));
  } catch (err) {
    await cleanup().catch(() => {});
    throw err;
  }
  return { dir, cleanup };
}

/** Symlink `target` at `path`, or copy it (owner-only) when the OS refuses the link. */
async function linkOrCopy(target: string, path: string): Promise<void> {
  try {
    await Deno.symlink(target, path);
  } catch (err) {
    if (Deno.build.os !== "windows") throw err;
    await Deno.copyFile(target, path);
    await Deno.chmod(path, 0o600).catch(() => {});
  }
}

/** A Google service account's fields that the token exchange needs. */
export interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

/**
 * Parse and check a service-account JSON.
 *
 * @throws {Error} Naming the missing field (never quoting the key).
 */
export function parseServiceAccount(text: string, path: string): ServiceAccount {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON`);
  }
  if (data.type !== "service_account") {
    throw new Error(`${path} is not a service-account key (type is ${JSON.stringify(data.type)})`);
  }
  for (const field of ["client_email", "private_key"]) {
    if (typeof data[field] !== "string" || !data[field]) throw new Error(`${path} has no ${field}`);
  }
  return data as unknown as ServiceAccount;
}

const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const PLAY_UPLOAD =
  "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";

/**
 * A Play Developer API access token for the service account (JWT bearer grant).
 *
 * @throws {Error} When the key cannot be imported or the token endpoint refuses it.
 */
async function playAccessToken(
  account: ServiceAccount,
  doFetch: typeof fetch,
  now: number,
): Promise<string> {
  const key = await importKey(account.private_key, "the service account's private_key", {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
  });
  const aud = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    { iss: account.client_email, scope: PLAY_SCOPE, aud, iat, exp: iat + 3600 },
    key,
    { name: "RSASSA-PKCS1-v1_5" },
  );
  const res = await doFetch(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google refused the service account (${await apiError(res)})`);
  const body = await res.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Google's token response had no access_token");
  return body.access_token;
}

/** Options for {@linkcode playUpload}. */
export interface PlayUploadOptions {
  readonly packageName: string;
  readonly artifact: string;
  /** The release track (`internal`, `alpha`, `beta`, `production`, or a custom one). */
  readonly track: string;
  /** `completed` (rolls out), `draft` (left for the console). */
  readonly status: "completed" | "draft";
  /** Open and delete an edit only (the dry run's access check). */
  readonly checkOnly?: boolean;
}

/** A Play API call: JSON in and out, throwing on a non-2xx. */
async function playCall(
  doFetch: typeof fetch,
  token: string,
  method: string,
  url: string,
  body?: BodyInit,
  type = "application/json",
): Promise<Record<string, unknown>> {
  const res = await doFetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": type } : {}) },
    ...(body ? { body } : {}),
  });
  if (!res.ok) {
    throw new Error(
      `Google Play: ${method} ${url.replace(/\?.*$/, "")} failed (${await apiError(res)})`,
    );
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Upload a bundle to Google Play through an edit: insert, upload, set the track release, commit.
 * With `checkOnly` the edit is opened and deleted (proves the account can edit the app).
 *
 * @returns The edit id and the uploaded version code (undefined with `checkOnly`).
 */
export async function playUpload(
  token: string,
  opts: PlayUploadOptions,
  doFetch: typeof fetch,
): Promise<{ editId: string; versionCode?: number }> {
  const app = `${PLAY_API}/${encodeURIComponent(opts.packageName)}`;
  const edit = await playCall(doFetch, token, "POST", `${app}/edits`, "{}");
  const editId = String(edit.id);
  const editUrl = `${app}/edits/${encodeURIComponent(editId)}`;
  if (opts.checkOnly) {
    await playCall(doFetch, token, "DELETE", editUrl);
    return { editId };
  }
  const kind = opts.artifact.endsWith(".apk") ? "apks" : "bundles";
  const uploaded = await playCall(
    doFetch,
    token,
    "POST",
    `${PLAY_UPLOAD}/${encodeURIComponent(opts.packageName)}/edits/${
      encodeURIComponent(editId)
    }/${kind}?uploadType=media`,
    await Deno.readFile(opts.artifact),
    "application/octet-stream",
  );
  const versionCode = Number(uploaded.versionCode);
  await playCall(
    doFetch,
    token,
    "PUT",
    `${editUrl}/tracks/${encodeURIComponent(opts.track)}`,
    JSON.stringify({
      track: opts.track,
      releases: [{ versionCodes: [String(versionCode)], status: opts.status }],
    }),
  );
  await playCall(doFetch, token, "POST", `${editUrl}:commit`);
  return { editId, versionCode };
}

/** Dependencies of the submit runners (tests pass fakes). */
export interface SubmitDeps {
  readonly fetch: typeof fetch;
  readonly run: BuildRunner;
  readonly now: () => number;
}

/** Options for {@linkcode submitIos}. */
export interface SubmitIosOptions {
  readonly artifact: string;
  readonly bundleId?: string;
  readonly creds?: Partial<AscCredentials>;
  readonly dryRun: boolean;
  /** Skip the network lookups (a dry run then checks the files and the key only). */
  readonly offline?: boolean;
}

/** The report of a submit (or its dry run). */
export interface SubmitReport {
  readonly platform: MobilePlatform;
  readonly artifact: string;
  readonly checks: SubmitCheck[];
  /** The upload command / API sequence, as it would run (no secrets). */
  readonly upload: string;
  readonly uploaded: boolean;
  readonly dryRun: boolean;
}

/** Record one check's outcome (a thrown error is a failed check). */
async function check(
  checks: SubmitCheck[],
  label: string,
  fn: () => Promise<string> | string,
): Promise<boolean> {
  try {
    checks.push({ label, ok: true, detail: await fn() });
    return true;
  } catch (err) {
    checks.push({ label, ok: false, detail: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** The artifact check, as a submit check. */
async function artifactCheck(checks: SubmitCheck[], path: string): Promise<boolean> {
  return await check(checks, "artifact", async () => {
    const bytes = await Deno.readFile(path);
    const result = checkArtifact(path, bytes);
    if (result.errors.length) throw new Error(result.errors.join("; "));
    return `${basename(path)} (${result.kind}, signed, ${(bytes.length / 1048576).toFixed(1)} MB)`;
  });
}

/** Complete credentials, or the names of what is missing. */
function completeAsc(creds: Partial<AscCredentials> | undefined): AscCredentials | string {
  const missing = [
    ...(creds?.keyPath ? [] : ["the key file (--asc-key / DENEXT_ASC_KEY_PATH)"]),
    ...(creds?.keyId ? [] : ["the key id (--asc-key-id / DENEXT_ASC_KEY_ID)"]),
    ...(creds?.issuerId ? [] : ["the issuer id (--asc-issuer / DENEXT_ASC_ISSUER_ID)"]),
  ];
  return missing.length ? `missing ${missing.join(", ")}` : creds as AscCredentials;
}

/**
 * Submit an .ipa to App Store Connect (or, with `dryRun`, check that it could be).
 *
 * @returns The report; `uploaded` is true only after altool succeeded.
 */
export async function submitIos(opts: SubmitIosOptions, deps: SubmitDeps): Promise<SubmitReport> {
  const checks: SubmitCheck[] = [];
  let ok = await artifactCheck(checks, opts.artifact);
  const creds = completeAsc(opts.creds);
  let token: string | undefined;
  ok = await check(checks, "API key", async () => {
    if (typeof creds === "string") throw new Error(creds);
    token = await ascToken(creds, deps.now());
    return `key ${creds.keyId} signs an ES256 token (issuer ${creds.issuerId})`;
  }) && ok;
  if (token && !opts.offline) {
    ok = await check(checks, "App Store Connect", async () => {
      if (!opts.bundleId) {
        throw new Error("no bundle id to look up (--app-id, or the build's sidecar)");
      }
      const app = await ascFindApp(token!, opts.bundleId, deps.fetch);
      if (!app) {
        throw new Error(
          `the key's account has no app with bundle id ${opts.bundleId} (create it in App Store Connect first)`,
        );
      }
      return `${app.name} (${opts.bundleId}, app ${app.id})`;
    }) && ok;
  }
  const keyId = typeof creds === "string" ? "<key id>" : creds.keyId;
  const issuer = typeof creds === "string" ? "<issuer id>" : creds.issuerId;
  const upload =
    `xcrun altool --upload-app -f ${opts.artifact} -t ios --apiKey ${keyId} --apiIssuer ${issuer}`;
  const report = {
    platform: "ios" as const,
    artifact: opts.artifact,
    checks,
    upload,
    dryRun: opts.dryRun,
  };
  if (opts.dryRun || !ok || typeof creds === "string") return { ...report, uploaded: false };
  const keys = await altoolKeysDir(creds);
  try {
    const { code } = await deps.run(altoolCommand(opts.artifact, creds, keys.dir));
    checks.push({
      label: "upload",
      ok: code === 0,
      detail: code === 0 ? "uploaded" : `altool exited with ${code}`,
    });
    return { ...report, uploaded: code === 0 };
  } finally {
    await keys.cleanup();
  }
}

/** Options for {@linkcode submitAndroid}. */
export interface SubmitAndroidOptions {
  readonly artifact: string;
  readonly packageName?: string;
  readonly serviceAccount?: string;
  readonly track: string;
  readonly status: "completed" | "draft";
  readonly dryRun: boolean;
  readonly offline?: boolean;
}

/**
 * Submit an .aab / .apk to Google Play (or, with `dryRun`, check that it could be).
 *
 * @returns The report; `uploaded` is true only after the edit was committed.
 */
export async function submitAndroid(
  opts: SubmitAndroidOptions,
  deps: SubmitDeps,
): Promise<SubmitReport> {
  const checks: SubmitCheck[] = [];
  let ok = await artifactCheck(checks, opts.artifact);
  let account: ServiceAccount | undefined;
  ok = await check(checks, "service account", async () => {
    if (!opts.serviceAccount) {
      throw new Error("no service-account JSON (--service-account / DENEXT_PLAY_SERVICE_ACCOUNT)");
    }
    account = parseServiceAccount(
      await Deno.readTextFile(opts.serviceAccount),
      opts.serviceAccount,
    );
    await importKey(account.private_key, "the service account's private_key", {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    });
    return account.client_email;
  }) && ok;
  ok = await check(checks, "package", () => {
    if (!opts.packageName) throw new Error("no package name (--app-id, or the build's sidecar)");
    return opts.packageName;
  }) && ok;
  let token: string | undefined;
  if (account && opts.packageName && !opts.offline) {
    ok = await check(checks, "Google Play", async () => {
      token = await playAccessToken(account!, deps.fetch, deps.now());
      if (!opts.dryRun) return "token accepted";
      const { editId } = await playUpload(token, {
        ...opts,
        packageName: opts.packageName!,
        checkOnly: true,
      }, deps.fetch);
      return `the account can edit ${opts.packageName} (edit ${editId} opened and deleted)`;
    }) && ok;
  }
  const upload = `Google Play Developer API: edits.insert → ${
    opts.artifact.endsWith(".apk") ? "apks" : "bundles"
  }.upload → tracks.update (${opts.track}, ${opts.status}) → edits.commit`;
  const report = {
    platform: "android" as const,
    artifact: opts.artifact,
    checks,
    upload,
    dryRun: opts.dryRun,
  };
  if (opts.dryRun || !ok || !token) return { ...report, uploaded: false };
  const done = await check(checks, "upload", async () => {
    const r = await playUpload(token!, { ...opts, packageName: opts.packageName! }, deps.fetch);
    return `version code ${r.versionCode} released to ${opts.track} (${opts.status})`;
  });
  return { ...report, uploaded: done };
}

/** The report as `mobile submit` prints it. */
export function formatSubmitReport(report: SubmitReport): string {
  const lines = report.checks.map((c) =>
    `  ${c.ok ? "ok  " : "FAIL"}  ${c.label.padEnd(18)} ${c.detail}`
  );
  lines.push("", `  ${report.dryRun ? "would run" : "ran"}: ${report.upload}`);
  const failed = report.checks.some((c) => !c.ok);
  lines.push(
    "",
    report.uploaded
      ? "  Uploaded."
      : report.dryRun
      ? failed
        ? "  Dry run: fix the failures above before submitting."
        : "  Dry run: ready to submit (nothing was uploaded)."
      : "  Not uploaded.",
  );
  return lines.join("\n");
}
