// The public keys that sign the revoked-runtimes list (src/build/runtime-revocations.ts): two
// ECDSA P-256 keys as base64 SPKI, the active one and an offline backup, so a key can be rotated
// with no gap (a list signed by either verifies). The private halves never enter the repository:
// the active one lives in the maintainer's login keychain (`deno task revocations keygen`, see
// CONTRIBUTING.md → "A bad runtime release"), the backup offline.
//
// An empty slot is no key. With both empty the revocation check is a no-op: denext reads no cached
// list and fetches nothing.

/**
 * The compiled-in revocation-list public keys (base64 SPKI, ECDSA P-256): `[active, backup]`.
 * An empty string is an unset slot.
 */
export const RUNTIME_REVOCATION_PUBLIC_KEYS: readonly [active: string, backup: string] = [
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1ONKcv2NsDjbz5bEPbnVY5QnmWzoJ8DY6gxOVZI9XLM0cUGc5xlLy/Db921wMOvVJeBCa4R5wkttcd+P6wAO/A==",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEuDh/JXMBjzN1LfZg/kmonu+aGsHQutmtVJzJG2q5Gfc5FdcAgUzgtCzvfUNmfAML4Ysc8myF6rD9Gp0IifyXOw==",
];

/**
 * The sequence of the revoked-runtimes list published when this denext was released: a list
 * below it is never taken, so a fresh machine (no cached list) can't be handed an older,
 * still-valid list that omits a newer revocation. `deno task release` raises it to the published
 * list's sequence before the release commit (`deno task revocations floor`); `0` until a list is
 * published.
 */
export const RUNTIME_REVOCATION_MIN_SEQUENCE: number = 0;
