// The public keys that sign the runtime channel index (src/build/runtime-channel.ts): two ECDSA
// P-256 keys as base64 SPKI, the active one and an offline backup, so a key can be rotated with no
// gap (an index signed by either verifies; during a rotation it carries both signatures). It is a
// key pair of its own, never the revoked-runtimes list's: that list's key can withdraw a channel
// key (`revokedChannelKeys`), so a stolen channel key is not the last word. The private halves
// never enter the repository: the active one lives in the maintainer's login keychain on the
// signing machine (`deno task runtime:keygen`, see CONTRIBUTING.md → "Releasing a runtime"), the
// backup offline. They are never a CI secret.
//
// An empty slot is no key. With both empty the channel is absent: nothing reads, fetches or
// trusts an index.

/**
 * The compiled-in runtime channel public keys (base64 SPKI, ECDSA P-256): `[active, backup]`.
 * An empty string is an unset slot.
 */
export const RUNTIME_CHANNEL_PUBLIC_KEYS: readonly [active: string, backup: string] = [
  // active
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEM9vtyVvo3gaOdM8IZHy0dabr4q1LKPywi42m3vV+EhpRS0uHZsgYTymKZdBsdVLrYIT8mm7Vb+MPLEf6Q/wXJA==",
  // backup
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/gbIxefgLKukaFmw0mzFW08ck2EQBCbo7Zh0j5dkAvsPGqiHBUurlBI+nZxW/CK4kMFmJEeMtjPa4ClZTLAegg==",
];

/**
 * The sequence of the channel index published when this denext was released: an index below it is
 * never taken, so a fresh machine can't be handed an older, still-valid index that hides a newer
 * yank. `deno task release` raises it to the published index's sequence before the release commit
 * (`deno task runtime:channel floor`); `0` until an index is published.
 */
export const RUNTIME_CHANNEL_MIN_SEQUENCE: number = 0;
