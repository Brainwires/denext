// Password hashing with PBKDF2 over Web Crypto (`crypto.subtle`) — a web standard,
// so this pulls in no dependency. Stored form is `salt:hash`, both base64.

const ENC = new TextEncoder();
const ITERATIONS = 100_000;

/** base64-encode raw bytes (small inputs only — salts and digests). */
function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Decode a base64 string back to bytes. */
function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Derive a 256-bit key from `password` + `salt` via PBKDF2-SHA-256. */
async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    ENC.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** Constant-time comparison so verification doesn't leak via timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Hash a password for storage. Returns `"<salt>:<hash>"` (both base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return `${toB64(salt)}:${toB64(hash)}`;
}

/** Verify a password against a stored `"<salt>:<hash>"` string. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(":");
  if (!saltB64 || !hashB64) return false;
  const hash = await pbkdf2(password, fromB64(saltB64));
  return timingSafeEqual(hash, fromB64(hashB64));
}
