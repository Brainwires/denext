// The environment variables denext's own desktop runtime modules read: the `denext/desktop` module
// graph (`src/build/desktop.ts`) and every `src/desktop/` module. `desktop.permissions: "strict"`
// bakes `--allow-env` scoped to this list, less the credential-shaped names
// (`DESKTOP_STRICT_RUNTIME_ENV`), plus the names the app declares, instead of the whole
// environment. tests/desktop-runtime-env.test.ts scans that graph and fails when a read of a name
// outside the list appears, or a name here is no longer read.

/**
 * Every environment variable the desktop runtime modules may read (or set), sorted. Most are
 * read best-effort (a refused read counts as unset); listing them keeps their behaviour the same
 * under a scoped `--allow-env`. Windows matches names case-insensitively; the lowercase proxy
 * spellings are for the other systems.
 */
export const DESKTOP_RUNTIME_ENV: readonly string[] = [
  "APPDATA",
  "DENEXT_ALLOW_REVOKED_RUNTIME",
  "DENEXT_APP_NAME",
  "DENEXT_BOOT_DDL",
  "DENEXT_CODESIGN_IDENTITY",
  "DENEXT_DEBUG_CACHE",
  "DENEXT_DESKTOP_DEV_LAN",
  "DENEXT_DESKTOP_DEV_URL",
  "DENEXT_DESKTOP_HEADLESS",
  "DENEXT_DESKTOP_PRELOAD_FILE",
  "DENEXT_DESKTOP_RUNTIME",
  "DENEXT_DESKTOP_RUNTIME_ATTEST",
  "DENEXT_DESKTOP_RUNTIME_DIR",
  "DENEXT_DESKTOP_RUNTIME_VERIFY",
  "DENEXT_DEV_TOKEN",
  "DENEXT_DOWNLOAD_ATTEMPTS",
  "DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS",
  "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS",
  "DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS",
  "DENEXT_ENV",
  "DENEXT_INSTALL",
  "DENEXT_LOCK_TIMEOUT",
  "DENEXT_NOTARY_ISSUER",
  "DENEXT_NOTARY_KEY",
  "DENEXT_NOTARY_KEY_ID",
  "DENEXT_NOTARY_PROFILE",
  "DENEXT_NO_DEPRECATION_WARNINGS",
  "DENEXT_OTA_SIGNING_KEY",
  "DENEXT_PROXY_DEBUG",
  "DENEXT_REVOCATION_CHECK",
  "DENEXT_REVOCATION_KEYS_FILE",
  "DENEXT_REVOCATION_NOTICED",
  "DENEXT_SIDECAR_CHILD",
  "DENEXT_SIDECAR_CHILD_ARGC",
  "DENEXT_SIGN_TIMESTAMP_URL",
  "DENEXT_STOCK_DEPRECATION_SHOWN",
  "DENEXT_TOOLCHAIN_ACTIVE",
  "DENEXT_TOOLCHAIN_PIN_FILE",
  "DENEXT_WINDOWS_CERT",
  "DENEXT_WINDOWS_CERT_PASSWORD",
  "DENEXT_WINDOWS_CERT_THUMBPRINT",
  "DENO_DEPLOYMENT_ID",
  "DENO_DESKTOP_APP_ORIGIN",
  "DENO_DESKTOP_WORKER_TOKEN",
  "DENO_DESKTOP_WS_URL",
  "DENO_DIR",
  "DENO_SERVE_ADDRESS",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LOCALAPPDATA",
  "NODE_ENV",
  "NO_PROXY",
  "PATH",
  "PORT",
  "ProgramFiles",
  "SESSION_SECRET",
  "SOURCE_DATE_EPOCH",
  "SystemRoot",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_DOCUMENTS_DIR",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/**
 * Credential- and signing-shaped variable names: the code-signing certificate and its password,
 * notarization keys, the OTA signing key, the signing identity and timestamp server, and any
 * `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY` / `*_KEY_ID` name. The `denext/desktop` graph
 * includes the packaging helpers that read them, but a packaged app never runs that code, so strict
 * mode never bakes them: a dependency of the app could otherwise read a signing key from the
 * environment of a developer or CI runner testing the app.
 */
const CREDENTIAL_ENV =
  /(?:^DENEXT_(?:WINDOWS_CERT|NOTARY|CODESIGN|SIGN|OTA_SIGNING)|_(?:TOKEN|SECRET|PASSWORD|KEY|KEY_ID|CERT)$)/i;

/**
 * Runtime-injected per-launch values a packaged app must read even though their names look like
 * credentials: the runtime hands `DENO_DESKTOP_WORKER_TOKEN` to a module sidecar's worker.
 */
const RUNTIME_INJECTED_ENV: ReadonlySet<string> = new Set(["DENO_DESKTOP_WORKER_TOKEN"]);

/**
 * Whether strict mode keeps `name` out of the baked `--allow-env` (a credential- or signing-shaped
 * name, see above). Names the app declares itself (`desktop.permissions.env`,
 * `desktop.extraPermissions.env`) are never filtered: declaring one is the app's choice.
 *
 * @param name A variable name.
 * @returns Whether it is credential-shaped.
 */
export function isCredentialEnvName(name: string): boolean {
  return !RUNTIME_INJECTED_ENV.has(name) && CREDENTIAL_ENV.test(name);
}

/**
 * The part of {@linkcode DESKTOP_RUNTIME_ENV} strict mode bakes: every name but the
 * credential-shaped ones ({@linkcode isCredentialEnvName}). A refused read counts as unset, so the
 * packaging helpers that read the others behave as with the variable unset (they never run in a
 * packaged app).
 */
export const DESKTOP_STRICT_RUNTIME_ENV: readonly string[] = DESKTOP_RUNTIME_ENV.filter(
  (name) => !isCredentialEnvName(name),
);
