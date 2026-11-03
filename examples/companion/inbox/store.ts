// The inbox file: where the running app listens and the token a sender must present. Created on
// the first run with a random token (owner-only on macOS and Linux) and reused after, so a script
// configured once keeps working; the URL is rewritten whenever the port changes.

/** What the inbox file holds. */
export interface InboxInfo {
  /** The inbox's base URL (`http://127.0.0.1:<port>`). */
  readonly url: string;
  /** The bearer token `POST /api/loopy/say` requires. */
  readonly token: string;
}

/** A fresh random token: 32 bytes, base64url. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A token the file may hold: base64url, long enough to be unguessable. */
const TOKEN = /^[A-Za-z0-9_-]{32,}$/;

/** The inbox file's contents, or `null` when it is missing or not an inbox file. */
export async function readInbox(path: string): Promise<InboxInfo | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
  const { url, token } = (raw ?? {}) as { url?: unknown; token?: unknown };
  if (typeof url !== "string" || typeof token !== "string" || !TOKEN.test(token)) return null;
  return { url, token };
}

/** The directory part of `path` (either separator). */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : ".";
}

/**
 * The token to use, creating the file on the first run, and record `url` in it. The file is
 * written owner-read/write only (mode 0600; Windows keeps the folder's ACL, which is per-user).
 *
 * @param path The inbox file.
 * @param url Where the inbox listens now.
 * @returns What the file holds after the call.
 */
export async function saveInbox(path: string, url: string): Promise<InboxInfo> {
  const token = (await readInbox(path))?.token ?? newToken();
  await Deno.mkdir(parentOf(path), { recursive: true });
  const info: InboxInfo = { url, token };
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  await Deno.rename(tmp, path);
  return info;
}
