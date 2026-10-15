/**
 * Optional FIDO Metadata Service (MDS3) checks for passkey registration
 * (`passkeys: { attestation: { mds: {} } }`). Off unless configured; nothing here touches the
 * network until a registration needs the metadata, and then only the configured URL (or the
 * app's own `blob` loader).
 *
 * **The BLOB.** The metadata is a signed JWT (FIDO MDS 3.0 §3.1.7). Its header's `x5c` chain
 * must validate ({@link ./x509-chain.ts}) to the FIDO root pinned below — GlobalSign Root CA -
 * R3, the root FIDO names — never to a certificate the response carries, and its leaf must be
 * issued for `mds.fidoalliance.org`; then the JWS signature is checked with the leaf's key. A
 * mirror (`url`) or an offline copy (`blob`) is held to the same checks, so neither needs to be
 * trusted. The parsed BLOB is kept in memory until its `nextUpdate`; a BLOB older than the one
 * held (a lower `no`) or already a day past its own `nextUpdate` is refused, so a replayed old
 * BLOB can't revive a revoked authenticator. When a refresh fails, the held BLOB serves for one
 * more day past its `nextUpdate`, then registrations fail closed until a refresh succeeds
 * (retried at most every five minutes).
 *
 * **A registration** is checked after the WebAuthn verification ({@link ./webauthn.ts}):
 * - `packed` attestation with `x5c` (`"basic"`): the authenticator's AAGUID must have a
 *   metadata entry (unless `allowUnknownAuthenticators`), and the `x5c` chain must validate to
 *   that entry's `attestationRootCertificates`.
 * - `none` or self attestation proves no model, so it is refused unless `allowUnattested` —
 *   synced passkeys (most phone and password-manager passkeys) attest `none`.
 * - Any AAGUID with a metadata entry is refused when the entry's status says the authenticator
 *   is compromised: its latest report is `USER_VERIFICATION_BYPASS`,
 *   `ATTESTATION_KEY_COMPROMISE`, `USER_KEY_REMOTE_COMPROMISE`, `USER_KEY_PHYSICAL_COMPROMISE`
 *   or `REVOKED` — and `REVOKED` / `ATTESTATION_KEY_COMPROMISE` anywhere in its history.
 *
 * Revocation lists (CRLs) of the BLOB's and the attestation's certificates are not fetched.
 *
 * @module
 */

import { hex, type RegistrationResult, WebAuthnError } from "./webauthn.ts";
import { base64UrlDecode } from "./oauth.ts";
import { base64Der, dnsNames, verifyCertificateChain, verifyWithSpki } from "./x509-chain.ts";
import type { AuthPasskeyMdsConfig } from "./types.ts";

/** The MDS settings, defaults applied. `roots` is always the pinned FIDO root in production. */
export interface ResolvedMds {
  url: string;
  blob?: AuthPasskeyMdsConfig["blob"];
  timeoutMs: number;
  maxBytes: number;
  allowUnattested: boolean;
  allowUnknownAuthenticators: boolean;
  /** The BLOB's trust anchors (DER). */
  roots: readonly Uint8Array[];
}

/** One authenticator's metadata entry, as the checks read it. */
interface MdsEntry {
  statusReports: { status: string; effectiveDate?: string }[];
  attestationRootCertificates: string[];
}

/** A verified BLOB. */
export interface MdsBlob {
  /** The BLOB's serial number. */
  no: number;
  /** When the next BLOB is due, epoch ms. */
  nextUpdate: number;
  /** Entries by AAGUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, lower case). */
  entries: Map<string, MdsEntry>;
}

/** GlobalSign Root CA - R3 (SHA-256 `CB:B5:22:D7:…:C9:63:C5:3B`), valid until 2029-03-18. */
const FIDO_MDS_ROOT = [
  "MIIDXzCCAkegAwIBAgILBAAAAAABIVhTCKIwDQYJKoZIhvcNAQELBQAwTDEgMB4GA1UECxMXR2xv",
  "YmFsU2lnbiBSb290IENBIC0gUjMxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkdsb2Jh",
  "bFNpZ24wHhcNMDkwMzE4MTAwMDAwWhcNMjkwMzE4MTAwMDAwWjBMMSAwHgYDVQQLExdHbG9iYWxT",
  "aWduIFJvb3QgQ0EgLSBSMzETMBEGA1UEChMKR2xvYmFsU2lnbjETMBEGA1UEAxMKR2xvYmFsU2ln",
  "bjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMwldpB5BngiFvXAg7aEyiie/QV2EcWt",
  "iHL8RgJDx7KKnQRfJMsuS+FggkbhUqsMgUdwbN1k0ev1LKMPgj0MK66X17YUhhB5uzsTgHeMCOFJ",
  "0mpiLx9e+pZo34knlTifBtc+ycsmWQ1z3rDI6SYOgxXG71uL0gRgykmmKPZpO/bLyCiR5Z2KYVc3",
  "rHQU3HTgOu5yLy6c+9C7v/U9AOEGM+iCK65TpjoWc4zdQQ4gOsC0p6Hpsk+QLjJg6VfLuQSSaGjl",
  "OCZgdbKfd/+RFO+uIEn8rUAVSNECMWEZXriX7613t2Saer9fwRPvm2L7DWzgVGkWqQPabumDk3F2",
  "xmmFghcCAwEAAaNCMEAwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYE",
  "FI/wS3+oLkUkrk1Q+mOai97i3Ru8MA0GCSqGSIb3DQEBCwUAA4IBAQBLQNvAUKr+yAzv95ZURUm7",
  "lgAJQayzE4aGKAczymvmdLm6AC2upArT9fHxD4q/c2dKg8dEe3jgr25sbwMpjjM5RcOO5LlXbKr8",
  "EpbsU8Yt5CRsuZRj+9xTaGdWPoO4zzUhw8lo/s7awlOqzJCK6fBdRoyV3XpYKBovHd7NADdBj+1E",
  "bddTKJd+82cEHhXXipa0095MJ6RMG3NzdvQXmcIfeg7jLQitChws/zyrVQ4PkX4268NXSb7hLi18",
  "YIvDQVETI53O9zJrlAGomecsMx86OyXShkDOOyyGeMlhLxS67ttVb9+E7gUJTb0o2HLO02JQZR7r",
  "kpeDMdmztcpHWD9f",
].join("");

/** The host the BLOB's signing certificate must be issued for. */
const MDS_SIGNER_HOST = "mds.fidoalliance.org";
const DEFAULT_URL = "https://mds.fidoalliance.org/";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a held BLOB outlives its `nextUpdate` while refreshes fail. */
const GRACE_MS = DAY_MS;
/** The least time between two refresh attempts after a failure. */
const RETRY_MS = 5 * 60 * 1000;

/** Statuses that refuse an authenticator when they are its latest report. */
const COMPROMISED = new Set([
  "USER_VERIFICATION_BYPASS",
  "ATTESTATION_KEY_COMPROMISE",
  "USER_KEY_REMOTE_COMPROMISE",
  "USER_KEY_PHYSICAL_COMPROMISE",
  "REVOKED",
]);
/** Statuses that refuse an authenticator wherever they appear in its history. */
const PERMANENT = new Set(["REVOKED", "ATTESTATION_KEY_COMPROMISE"]);

function refuse(message: string): never {
  throw new WebAuthnError("attestation", message);
}

/** A positive integer option, or its default. */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Resolve `passkeys.attestation.mds` (validated once, at config time).
 *
 * @param config The option.
 * @returns The settings, or `null` when MDS checks are off.
 * @throws {Error} When `url` is not `https:`.
 */
export function resolveMds(config: AuthPasskeyMdsConfig | undefined): ResolvedMds | null {
  if (!config) return null;
  const url = config.url ?? DEFAULT_URL;
  if (new URL(url).protocol !== "https:") {
    throw new Error("denextAuth: `passkeys.attestation.mds.url` must be an https URL");
  }
  return {
    url,
    blob: config.blob,
    timeoutMs: positive(config.timeoutMs, 15_000),
    maxBytes: positive(config.maxBytes, 32 * 1024 * 1024),
    allowUnattested: config.allowUnattested === true,
    allowUnknownAuthenticators: config.allowUnknownAuthenticators === true,
    roots: [base64Der(FIDO_MDS_ROOT)],
  };
}

// ---- the BLOB ------------------------------------------------------------------------

/** A JSON object out of base64url, or a refusal. */
function jsonPart(part: string, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* refused below */ }
  return refuse(`the metadata BLOB's ${what} is not a JSON object`);
}

/** `"YYYY-MM-DD"` → epoch ms (UTC midnight). */
function dateMs(value: unknown): number {
  const m = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) refuse("the metadata BLOB has no valid nextUpdate");
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The entries with an AAGUID (FIDO2 authenticators), keyed by it. */
function entriesOf(raw: unknown): Map<string, MdsEntry> {
  if (!Array.isArray(raw)) refuse("the metadata BLOB has no entries");
  const out = new Map<string, MdsEntry>();
  for (const entry of raw) {
    const aaguid = entry?.aaguid;
    if (typeof aaguid !== "string") continue; // a UAF / U2F entry
    const roots = entry.metadataStatement?.attestationRootCertificates;
    out.set(aaguid.toLowerCase(), {
      statusReports: Array.isArray(entry.statusReports)
        ? entry.statusReports.filter((r: unknown) =>
          typeof (r as { status?: unknown })?.status === "string"
        )
        : [],
      attestationRootCertificates: Array.isArray(roots)
        ? roots.filter((r: unknown) => typeof r === "string")
        : [],
    });
  }
  return out;
}

/** Check the JWS: its `x5c` chain to `roots`, its signer's host, its signature. */
async function verifyJws(
  parts: string[],
  header: Record<string, unknown>,
  roots: readonly Uint8Array[],
  now: number,
): Promise<void> {
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length === 0 || typeof header.alg !== "string") {
    refuse("the metadata BLOB's header has no alg / x5c");
  }
  const leaf = await verifyCertificateChain(x5c.map(base64Der), roots, now);
  if (!dnsNames(leaf).includes(MDS_SIGNER_HOST)) {
    refuse("the metadata BLOB is not signed by the FIDO Metadata Service");
  }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await verifyWithSpki(leaf.spki, header.alg, base64UrlDecode(parts[2]), signed))) {
    refuse("the metadata BLOB's signature does not verify");
  }
}

/**
 * Verify a metadata BLOB (a compact JWS) against `roots` and parse it.
 *
 * @param jwt The BLOB.
 * @param roots The trust anchors (DER) — the pinned FIDO root in production.
 * @param now The validation time, epoch ms.
 * @returns The verified BLOB.
 * @throws {WebAuthnError} `attestation` when it doesn't verify; a `CertificateChainError` when
 *   its chain doesn't.
 */
export async function verifyMdsBlob(
  jwt: string,
  roots: readonly Uint8Array[],
  now: number,
): Promise<MdsBlob> {
  const parts = jwt.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    refuse("the metadata BLOB is not a compact JWS");
  }
  await verifyJws(parts, jsonPart(parts[0], "header"), roots, now);
  const payload = jsonPart(parts[1], "payload");
  if (typeof payload.no !== "number" || !Number.isSafeInteger(payload.no)) {
    refuse("the metadata BLOB has no serial number");
  }
  return {
    no: payload.no,
    nextUpdate: dateMs(payload.nextUpdate),
    entries: entriesOf(payload.entries),
  };
}

/** Read a response body, refusing more than `max` bytes. */
async function cappedText(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) {
    await response.body?.cancel();
    refuse("the metadata BLOB is too large");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let step = await reader?.read(); step && !step.done; step = await reader!.read()) {
    total += step.value.byteLength;
    if (total > max) {
      await reader!.cancel();
      refuse("the metadata BLOB is too large");
    }
    chunks.push(step.value);
  }
  const out = new Uint8Array(total);
  chunks.reduce((at, chunk) => (out.set(chunk, at), at + chunk.byteLength), 0);
  return new TextDecoder().decode(out);
}

/** The BLOB's text: the app's own copy, or one fetch (timeout + size cap). */
async function blobText(mds: ResolvedMds): Promise<string> {
  if (mds.blob !== undefined) {
    return typeof mds.blob === "function" ? await mds.blob() : mds.blob;
  }
  const response = await fetch(mds.url, {
    signal: AbortSignal.timeout(mds.timeoutMs),
    headers: { accept: "application/jwt, text/plain" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    refuse(`the metadata BLOB fetch answered ${response.status}`);
  }
  return await cappedText(response, mds.maxBytes);
}

/** What one MDS configuration holds between registrations. */
interface MdsCache {
  blob?: MdsBlob;
  inFlight?: Promise<MdsBlob>;
  lastFailure?: number;
}

const caches = new WeakMap<ResolvedMds, MdsCache>();

/** Fetch and verify a fresh BLOB; refuse a rollback or one already stale. */
async function refresh(mds: ResolvedMds, held: MdsBlob | undefined, now: number): Promise<MdsBlob> {
  const blob = await verifyMdsBlob(await blobText(mds), mds.roots, now);
  if (held && blob.no < held.no) refuse("the metadata BLOB is older than the one held");
  if (blob.nextUpdate + GRACE_MS <= now) refuse("the metadata BLOB is out of date");
  return blob;
}

/** The held BLOB while it may still serve (until a day past its `nextUpdate`), else a refusal. */
function heldOrRefuse(cache: MdsCache, now: number, cause?: unknown): MdsBlob {
  if (cache.blob && now < cache.blob.nextUpdate + GRACE_MS) return cache.blob;
  const reason = cause instanceof Error ? `: ${cause.message}` : "";
  return refuse(`the FIDO metadata is unavailable${reason}`);
}

/**
 * The current verified BLOB for this configuration: the held one until its `nextUpdate`, then
 * a refresh (one at a time; after a failure, at most every five minutes).
 *
 * @param mds The settings.
 * @param now The time, epoch ms.
 * @returns The BLOB.
 * @throws {WebAuthnError} `attestation` when no usable BLOB can be had.
 */
export async function currentMdsBlob(mds: ResolvedMds, now = Date.now()): Promise<MdsBlob> {
  let cache = caches.get(mds);
  if (!cache) caches.set(mds, cache = {});
  if (cache.blob && now < cache.blob.nextUpdate) return cache.blob;
  if (cache.lastFailure !== undefined && now - cache.lastFailure < RETRY_MS) {
    return heldOrRefuse(cache, now);
  }
  const state = cache;
  state.inFlight ??= refresh(mds, state.blob, now).finally(() => {
    state.inFlight = undefined;
  });
  try {
    state.blob = await state.inFlight;
    state.lastFailure = undefined;
    return state.blob;
  } catch (error) {
    state.lastFailure = now;
    return heldOrRefuse(state, now, error);
  }
}

// ---- a registration -----------------------------------------------------------------

/** `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` of a 16-byte AAGUID. */
function aaguidString(aaguid: Uint8Array): string {
  const h = hex(aaguid);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The latest report (by `effectiveDate`; the later one in the list on a tie). */
function latestStatus(reports: MdsEntry["statusReports"]): string | undefined {
  let latest: MdsEntry["statusReports"][number] | undefined;
  for (const report of reports) {
    if (!latest || (report.effectiveDate ?? "") >= (latest.effectiveDate ?? "")) latest = report;
  }
  return latest?.status;
}

/** Refuse an entry whose status reports compromise. */
function checkStatus(entry: MdsEntry): void {
  const latest = latestStatus(entry.statusReports);
  if (
    (latest && COMPROMISED.has(latest)) ||
    entry.statusReports.some((r) => PERMANENT.has(r.status))
  ) {
    refuse("the authenticator's metadata reports it compromised");
  }
}

/** A certificate attestation: a known AAGUID whose roots the `x5c` chains to. */
async function checkCertified(
  mds: ResolvedMds,
  entry: MdsEntry | undefined,
  x5c: Uint8Array[],
  now: number,
): Promise<void> {
  if (!entry) {
    if (mds.allowUnknownAuthenticators) return;
    refuse("the authenticator has no FIDO metadata");
  }
  const roots = entry.attestationRootCertificates.map(base64Der);
  try {
    await verifyCertificateChain(x5c, roots, now);
  } catch {
    refuse("the attestation does not chain to the authenticator's metadata roots");
  }
}

/**
 * Hold a verified registration to the FIDO Metadata Service policy (see the module doc).
 *
 * @param mds The settings.
 * @param result What {@linkcode verifyRegistration} established.
 * @param now The time, epoch ms.
 * @throws {WebAuthnError} `attestation` when the policy refuses it.
 */
export async function checkMdsAttestation(
  mds: ResolvedMds,
  result: Pick<RegistrationResult, "aaguid" | "attestationType" | "attestationCertificates">,
  now = Date.now(),
): Promise<void> {
  const certified = result.attestationType === "basic" && !!result.attestationCertificates;
  if (!certified && !mds.allowUnattested) {
    refuse("an attestation certificate is required (passkeys.attestation.mds)");
  }
  // An all-zero AAGUID names no model: nothing to look up.
  if (!certified && result.aaguid.every((b) => b === 0)) return;
  const blob = await currentMdsBlob(mds, now);
  const entry = blob.entries.get(aaguidString(result.aaguid));
  if (entry) checkStatus(entry);
  if (certified) await checkCertified(mds, entry, result.attestationCertificates!, now);
}
