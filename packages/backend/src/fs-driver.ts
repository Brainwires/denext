// The filesystem driver, for development and self-hosting: objects are files under
// `<dir>/<bucket>/<key>`, with their content type in a sidecar under `<dir>/.denext-meta/`.
// Writes land in `<dir>/.denext-tmp/` first and are renamed into place, so a reader never sees
// a partial object and a refused upload leaves nothing behind. Every path is confined to its
// bucket directory — lexically, and again after symlinks are resolved.

import { dirname, isAbsolute, join, resolve, SEPARATOR } from "@std/path";
import { StorageError } from "./errors.ts";
import type {
  ByteRange,
  ListedObject,
  ListResult,
  ObjectInfo,
  PutInfo,
  StorageDriver,
  StoredObject,
} from "./types.ts";
import { fromBase64Url, toBase64Url } from "./signing.ts";

/** Options for {@link fs}. */
export interface FsDriverOptions {
  /** The storage directory; a relative path resolves against the project root. */
  dir: string;
}

const META_DIR = ".denext-meta";
const TMP_DIR = ".denext-tmp";
/** Characters a key segment may not carry on disk (Windows-reserved, so keys stay portable). */
const NON_PORTABLE = /[:*?"<>|]|[. ]$/;

interface Meta {
  contentType: string;
  etag: string;
}

/**
 * The filesystem storage driver: `fs({ dir: ".storage" })`. Downloads and uploads go through
 * the plugin's own endpoint with HMAC-signed, expiring URLs (Range requests supported). Meant
 * for development and single-server self-hosting; listings walk the directory.
 *
 * @param options The storage directory.
 * @returns The driver.
 */
export function fs(options: FsDriverOptions): StorageDriver {
  if (!options || typeof options.dir !== "string" || !options.dir) {
    throw new TypeError("fs(): `dir` is required");
  }
  let root = resolve(options.dir);
  let realRoot: Promise<string> | undefined;
  const paths = {
    object: (bucket: string, key: string) => confined(join(root, bucket), key),
    meta: (bucket: string, key: string) => confined(join(root, META_DIR, bucket), key) + ".json",
    realRoot: () => (realRoot ??= ensureDir(root).then(() => Deno.realPath(root))),
  };
  return {
    name: "fs",
    init({ projectRoot }) {
      root = isAbsolute(options.dir) ? options.dir : resolve(projectRoot, options.dir);
      realRoot = undefined;
    },
    put: (bucket, key, body, info) => putObject(root, paths, bucket, key, body, info),
    async get(bucket, key, range) {
      const file = await openConfined(paths, paths.object(bucket, key));
      if (!file) return null;
      return await readObject(file, paths.meta(bucket, key), key, range);
    },
    async head(bucket, key) {
      const path = paths.object(bucket, key);
      if (!(await isConfinedFile(paths, path))) return null;
      return await infoOf(path, paths.meta(bucket, key), key);
    },
    async remove(bucket, key) {
      const path = paths.object(bucket, key);
      if (!(await isConfinedFile(paths, path))) return;
      await removeIfExists(path);
      await removeIfExists(paths.meta(bucket, key));
    },
    list: (bucket, prefix, opts) => listObjects(join(root, bucket), paths, bucket, prefix, opts),
  };
}

type Paths = {
  object(bucket: string, key: string): string;
  meta(bucket: string, key: string): string;
  realRoot(): Promise<string>;
};

/** `base/<key>`, refusing a non-portable segment or anything that escapes `base`. */
function confined(base: string, key: string): string {
  const segments = key.split("/");
  if (segments.some((s) => NON_PORTABLE.test(s))) {
    throw new StorageError("invalid_key", "object key has a character the fs driver cannot store");
  }
  const path = resolve(base, ...segments);
  if (!path.startsWith(resolve(base) + SEPARATOR)) {
    throw new StorageError("invalid_key", "object key escapes its bucket");
  }
  return path;
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

/** Whether the real (symlink-resolved) path stays under the real storage root. */
async function underRoot(paths: Paths, path: string): Promise<boolean> {
  const root = await paths.realRoot();
  return path === root || path.startsWith(root + SEPARATOR);
}

/** Whether `path` is a regular file whose real path is under the root. */
async function isConfinedFile(paths: Paths, path: string): Promise<boolean> {
  try {
    const real = await Deno.realPath(path);
    return (await underRoot(paths, real)) && (await Deno.stat(real)).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound || err instanceof Deno.errors.NotADirectory) {
      return false;
    }
    throw err;
  }
}

async function openConfined(paths: Paths, path: string): Promise<Deno.FsFile | null> {
  if (!(await isConfinedFile(paths, path))) return null;
  return await Deno.open(path, { read: true });
}

async function readMeta(metaPath: string): Promise<Meta | null> {
  try {
    return JSON.parse(await Deno.readTextFile(metaPath)) as Meta;
  } catch {
    return null;
  }
}

async function infoOf(path: string, metaPath: string, key: string): Promise<ObjectInfo> {
  const stat = await Deno.stat(path);
  const meta = await readMeta(metaPath);
  return {
    key,
    size: stat.size,
    contentType: meta?.contentType ?? "application/octet-stream",
    etag: meta?.etag ?? `${stat.size.toString(16)}-${(stat.mtime?.getTime() ?? 0).toString(16)}`,
    lastModified: stat.mtime ?? undefined,
  };
}

/** A stream of `length` bytes of `file` from `start`, closing the file when done. */
function fileStream(file: Deno.FsFile, start: number, length: number): ReadableStream<Uint8Array> {
  let left = length;
  let seeked = false;
  const close = () => {
    try {
      file.close();
    } catch { /* already closed */ }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!seeked) {
        await file.seek(start, Deno.SeekMode.Start);
        seeked = true;
      }
      const buf = new Uint8Array(Math.min(64 * 1024, left));
      const n = left > 0 ? await file.read(buf) : null;
      if (n === null || n === 0) {
        close();
        controller.close();
        return;
      }
      left -= n;
      controller.enqueue(buf.subarray(0, n));
    },
    cancel: close,
  });
}

async function readObject(
  file: Deno.FsFile,
  metaPath: string,
  key: string,
  range?: ByteRange,
): Promise<StoredObject> {
  const stat = await file.stat();
  const meta = await readMeta(metaPath);
  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? stat.size - 1, stat.size - 1);
  return {
    key,
    size: stat.size,
    contentType: meta?.contentType ?? "application/octet-stream",
    etag: meta?.etag,
    lastModified: stat.mtime ?? undefined,
    body: fileStream(file, start, Math.max(0, end - start + 1)),
    ...(range ? { range: { start, end } } : {}),
  };
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** Write `data` to `dest` atomically (temp file + rename). */
async function writeAtomic(
  root: string,
  dest: string,
  data: ReadableStream<Uint8Array>,
): Promise<number> {
  const tmpDir = join(root, TMP_DIR);
  await ensureDir(tmpDir);
  const tmp = join(tmpDir, crypto.randomUUID());
  let size = 0;
  try {
    const file = await Deno.open(tmp, { write: true, createNew: true, mode: 0o600 });
    const counted = data.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    await counted.pipeTo(file.writable);
    await ensureDir(dirname(dest));
    await Deno.rename(tmp, dest);
    return size;
  } catch (err) {
    await removeIfExists(tmp);
    throw err;
  }
}

async function putObject(
  root: string,
  paths: Paths,
  bucket: string,
  key: string,
  body: ReadableStream<Uint8Array>,
  info: PutInfo,
): Promise<ObjectInfo> {
  const path = paths.object(bucket, key);
  const metaPath = paths.meta(bucket, key);
  try {
    await ensureDir(dirname(path));
    if (!(await underRoot(paths, await Deno.realPath(dirname(path))))) {
      throw new StorageError("invalid_key", "object key escapes the storage directory");
    }
    const size = await writeAtomic(root, path, body);
    const meta: Meta = { contentType: info.contentType, etag: toBase64Url(randomBytes(12)) };
    await writeAtomic(root, metaPath, new Blob([JSON.stringify(meta)]).stream());
    return { key, size, contentType: meta.contentType, etag: meta.etag, lastModified: new Date() };
  } catch (err) {
    if (
      err instanceof Deno.errors.IsADirectory || err instanceof Deno.errors.NotADirectory ||
      err instanceof Deno.errors.AlreadyExists
    ) {
      throw new StorageError("conflict", "a key and a key prefix collide on disk", { cause: err });
    }
    throw err;
  }
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Every file under `dir`, as `/`-joined keys relative to `base` (symlinks skipped). */
async function walkKeys(dir: string, rel: string, out: string[]): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound || err instanceof Deno.errors.NotADirectory) return;
    throw err;
  }
  for (const entry of entries) {
    const key = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) await walkKeys(join(dir, entry.name), key, out);
    else if (entry.isFile) out.push(key);
  }
}

function decodeCursor(cursor?: string): string {
  if (!cursor) return "";
  const bytes = fromBase64Url(cursor);
  if (!bytes) throw new StorageError("bad_request", "malformed cursor");
  return new TextDecoder().decode(bytes);
}

async function listObjects(
  bucketDir: string,
  paths: Paths,
  bucket: string,
  prefix: string,
  options: { limit: number; cursor?: string },
): Promise<ListResult> {
  const after = decodeCursor(options.cursor);
  const dirPart = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
  const keys: string[] = [];
  await walkKeys(dirPart ? join(bucketDir, ...dirPart.split("/")) : bucketDir, dirPart, keys);
  const matching = keys
    .filter((k) => k.startsWith(prefix) && k > after)
    .sort((a, b) => (a < b ? -1 : 1));
  const page = matching.slice(0, options.limit);
  const objects: ListedObject[] = await Promise.all(
    page.map((k) => infoOf(paths.object(bucket, k), paths.meta(bucket, k), k)),
  );
  const more = matching.length > page.length;
  return more
    ? { objects, cursor: toBase64Url(new TextEncoder().encode(page[page.length - 1])) }
    : { objects };
}
