// `denext storage <ls|cp|mv|rm>`: the Supabase CLI's `storage` group over the app's own storage
// (its driver and metadata, as the service role). A storage path is `ss:///<bucket>/<key>`
// (`ss://<bucket>/<key>` too); anything else is a local path. Contributed by
// `backend({ storage })`.
//
//   ls [ss:///bucket/prefix] [-r]    the buckets, or one folder level (-r: every key below)
//   cp <src> <dst> [-r]              local → bucket (upload), bucket → local, bucket → bucket
//   mv <src> <dst> [-r]              bucket → bucket
//   rm <ss:///…>… [-r] [--yes]       delete objects (-r: everything under a prefix; on a remote
//                                    store, confirmed at the terminal or with --yes)

import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import type { CommandContext, CommandSpec } from "@denext/denext/cli/command";
import { type CommandIo, consoleIo } from "./command-io.ts";
import { filesUnder } from "./files.ts";
import { runtime } from "./runtime.ts";
import { storage } from "./storage.ts";
import { seedContentType } from "./storage-seed.ts";

/** A parsed storage path. */
interface Remote {
  bucket: string;
  key: string;
}

/**
 * `ss:///bucket/key` (or `ss://bucket/key`) → its bucket and key; `undefined` for a local path.
 *
 * @param path The argument.
 * @returns The bucket and key.
 */
export function parseStoragePath(path: string): Remote | undefined {
  const match = /^ss:\/\/\/?([^/]*)\/?(.*)$/.exec(path);
  if (!match) return undefined;
  if (!match[1]) return { bucket: "", key: "" };
  return { bucket: match[1], key: match[2] };
}

const bucketOf = (name: string) => storage.bucket(name, { service: true });

/** Every key under `prefix` (all pages). */
async function keysUnder(remote: Remote): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucketOf(remote.bucket).list(remote.key, {
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.cursor;
  } while (cursor);
  return keys;
}

/** `ls` with no bucket: the buckets. */
async function listBucketNames(io: CommandIo): Promise<void> {
  for (const bucket of await storage.listBuckets({ service: true })) {
    io.log(`${bucket.name}/${bucket.public ? "  (public)" : ""}`);
  }
}

/** `ls ss:///bucket/prefix`: one folder level, folders first. */
async function listLevel(remote: Remote, io: CommandIo): Promise<void> {
  const prefix = remote.key && !remote.key.endsWith("/") ? `${remote.key}/` : remote.key;
  for (const entry of await bucketOf(remote.bucket).listFolder(prefix, { limit: 1000 })) {
    io.log(entry.id === null ? `${entry.name}/` : entry.name);
  }
}

async function ls(ctx: CommandContext, io: CommandIo): Promise<void> {
  const remote = parseStoragePath(ctx.positionals[1] ?? "ss:///");
  if (!remote) throw new TypeError("ls takes a storage path: ss:///<bucket>/<prefix>");
  if (!remote.bucket) return await listBucketNames(io);
  if (!recursive(ctx)) return await listLevel(remote, io);
  for (const key of await keysUnder(remote)) io.log(`${remote.bucket}/${key}`);
}

function recursive(ctx: CommandContext): boolean {
  return ctx.flags.recursive === true;
}

/** `src` and `dst` of `cp` / `mv`. */
function pair(ctx: CommandContext): [string, string] {
  const [, src, dst] = ctx.positionals;
  if (!src || !dst) throw new TypeError("give a source and a destination");
  return [src, dst];
}

/** Upload one local file. */
async function upload(file: string, to: Remote, ctx: CommandContext): Promise<void> {
  const type = typeof ctx.flags["content-type"] === "string"
    ? ctx.flags["content-type"]
    : seedContentType(file);
  await bucketOf(to.bucket).upload(to.key, await Deno.readFile(file), {
    upsert: true,
    ...(type ? { contentType: type } : {}),
    ...(typeof ctx.flags["cache-control"] === "string"
      ? { cacheControl: ctx.flags["cache-control"] }
      : {}),
  });
}

/** Download one object to a local file. */
async function download(from: Remote, file: string): Promise<void> {
  const object = await bucketOf(from.bucket).download(from.key);
  if (!object) throw new Error(`not found: ss:///${from.bucket}/${from.key}`);
  await Deno.mkdir(dirname(file), { recursive: true });
  await Deno.writeFile(file, object.body);
}

/** Join a key prefix and a relative path. */
function under(remote: Remote, rel: string): Remote {
  const base = remote.key.replace(/\/$/, "");
  return { bucket: remote.bucket, key: base ? `${base}/${rel}` : rel };
}

/** A key below a prefix, relative to it. */
function relativeKey(prefix: Remote, key: string): string {
  return key.slice(prefix.key.length).replace(/^\//, "");
}

/** One transfer of `cp`: what to do with each source item. */
async function copyLocalUp(src: string, to: Remote, ctx: CommandContext, io: CommandIo) {
  if (recursive(ctx)) {
    for (const file of await filesUnder(src)) {
      const target = under(to, relative(src, file).replaceAll("\\", "/"));
      await upload(file, target, ctx);
      io.log(`uploaded ${file} → ss:///${target.bucket}/${target.key}`);
    }
    return;
  }
  const target = to.key === "" || to.key.endsWith("/") ? under(to, src.split(/[\\/]/).pop()!) : to;
  await upload(src, target, ctx);
  io.log(`uploaded ${src} → ss:///${target.bucket}/${target.key}`);
}

/**
 * Where the object `rel` (a key relative to the copied prefix) lands under the folder `dst`.
 * Object keys come from the bucket, which other tooling may have written, so a key that would
 * land anywhere but inside `dst` (`..` segments, an absolute path, a drive letter, a backslash)
 * is refused.
 *
 * @param dst The destination folder (absolute).
 * @param rel The key below the copied prefix.
 * @returns The local file.
 * @throws {Error} For a key that would escape `dst`.
 */
function confinedPath(dst: string, rel: string): string {
  // The prefix named one object exactly: it is written as `dst` itself (as before).
  if (rel === "") return resolve(dst);
  const refused = () =>
    new Error(`refusing to download "${rel}": the key would be written outside ${dst}`);
  if (
    rel.includes("\\") || rel.includes("\0") || rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel) || rel.split("/").some((segment) => segment === "..")
  ) throw refused();
  const root = resolve(dst);
  const file = resolve(root, rel);
  if (!file.startsWith(root.endsWith(SEPARATOR) ? root : root + SEPARATOR)) throw refused();
  return file;
}

/**
 * Refuse to write `file` through a symbolic link below `dst`: each path component under the
 * destination folder that exists (the file included) is `lstat`ed, so a link planted inside the
 * folder can't send a download somewhere else. (`dst` itself is the caller's choice.)
 *
 * @param dst The destination folder.
 * @param file The file about to be written (inside `dst`).
 * @throws {Error} When a component is a symbolic link.
 */
async function refuseSymlinks(dst: string, file: string): Promise<void> {
  const root = resolve(dst);
  const rel = relative(root, file);
  let at = root;
  for (const part of rel ? rel.split(SEPARATOR) : []) {
    at = join(at, part);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(at);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return; // nothing below it exists yet
      throw error;
    }
    if (info.isSymlink) {
      throw new Error(`refusing to download to ${file}: ${at} is a symbolic link`);
    }
  }
}

async function copyDown(from: Remote, dst: string, ctx: CommandContext, io: CommandIo) {
  if (recursive(ctx)) {
    const keys = await keysUnder(from);
    // Every key is checked before anything is written.
    const files = keys.map((key) => confinedPath(dst, relativeKey(from, key)));
    for (const file of files) await refuseSymlinks(dst, file);
    for (const [i, key] of keys.entries()) {
      const file = files[i];
      await refuseSymlinks(dst, file); // again: an earlier write may have made a directory
      await download({ bucket: from.bucket, key }, file);
      io.log(`downloaded ss:///${from.bucket}/${key} → ${file}`);
    }
    return;
  }
  await download(from, dst);
  io.log(`downloaded ss:///${from.bucket}/${from.key} → ${dst}`);
}

/** Copy or move bucket → bucket (one object, or every one under a prefix with -r). */
async function transfer(
  from: Remote,
  to: Remote,
  ctx: CommandContext,
  io: CommandIo,
  verb: "copy" | "move",
): Promise<void> {
  const keys = recursive(ctx) ? await keysUnder(from) : [from.key];
  for (const key of keys) {
    const target = recursive(ctx) ? under(to, relativeKey(from, key)) : to;
    await bucketOf(from.bucket)[verb](key, target.key, { destinationBucket: to.bucket });
    io.log(
      `${
        verb === "copy" ? "copied" : "moved"
      } ss:///${from.bucket}/${key} → ss:///${target.bucket}/${target.key}`,
    );
  }
}

async function cp(ctx: CommandContext, io: CommandIo, root: string): Promise<void> {
  const [src, dst] = pair(ctx);
  const from = parseStoragePath(src);
  const to = parseStoragePath(dst);
  if (from && to) return await transfer(from, to, ctx, io, "copy");
  if (to) return await copyLocalUp(resolve(root, src), to, ctx, io);
  if (from) return await copyDown(from, resolve(root, dst), ctx, io);
  throw new TypeError("one side of cp must be a storage path (ss:///<bucket>/<key>)");
}

async function mv(ctx: CommandContext, io: CommandIo): Promise<void> {
  const [src, dst] = pair(ctx);
  const from = parseStoragePath(src);
  const to = parseStoragePath(dst);
  if (!from?.bucket || !to?.bucket) {
    throw new TypeError("mv moves between storage paths (ss:///<bucket>/<key>); use cp for files");
  }
  await transfer(from, to, ctx, io, "move");
}

/** Whether `host` (a URL's hostname) is this machine. */
function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * The store's location when it is REMOTE (a network store off this machine), else `undefined`:
 * the fs driver, and an S3-compatible store on a loopback endpoint, are local.
 *
 * @param location The storage driver's `location`.
 * @returns The location, or `undefined`.
 */
export function remoteStore(location: string | undefined): string | undefined {
  if (!location) return undefined;
  try {
    return isLoopbackHost(new URL(location).hostname) ? undefined : location;
  } catch {
    return location;
  }
}

/**
 * Gate `rm -r` on a remote store as `denext db` gates its destructive actions: `--yes` passes,
 * else a "yes" at the terminal; with no terminal it is refused.
 */
async function confirmRemote(ctx: CommandContext, io: CommandIo, what: string): Promise<void> {
  if (ctx.flags.yes === true) return;
  const remote = remoteStore(runtime().driver.location);
  if (!remote) return;
  const full = `${what} on the remote store ${remote}`;
  if (!io.confirm) throw new Error(`${full}: run it with --yes`);
  if (!await io.confirm(`${full}. Continue?`)) throw new Error(`cancelled (${full})`);
}

async function rm(ctx: CommandContext, io: CommandIo): Promise<void> {
  const paths = ctx.positionals.slice(1);
  if (!paths.length) throw new TypeError("rm takes one or more storage paths");
  const remotes = paths.map((path) => {
    const remote = parseStoragePath(path);
    if (!remote?.bucket) throw new TypeError(`not a storage path: ${path}`);
    return remote;
  });
  if (recursive(ctx)) {
    await confirmRemote(
      ctx,
      io,
      `rm -r deletes everything under ${paths.map((p) => JSON.stringify(p)).join(", ")}`,
    );
  }
  for (const remote of remotes) {
    const keys = recursive(ctx) ? await keysUnder(remote) : [remote.key];
    if (keys.length) await bucketOf(remote.bucket).remove(keys);
    for (const key of keys) io.log(`removed ss:///${remote.bucket}/${key}`);
  }
}

type Action = (ctx: CommandContext, io: CommandIo, root: string) => Promise<void>;

const ACTIONS: Record<string, Action> = { ls, cp, mv, rm };

/**
 * The `storage` verb.
 *
 * @param io Where it prints.
 * @returns The command.
 */
export function createStorageCommand(io: CommandIo = consoleIo): CommandSpec {
  return {
    name: "storage",
    summary: "List, copy, move and remove storage objects (@denext/backend)",
    usage: [
      "Usage: denext storage <ls|cp|mv|rm> [paths] [flags]",
      "",
      "  ls [ss:///bucket/prefix]   The buckets, or one folder level (-r: every key below)",
      "  cp <src> <dst>             local → bucket, bucket → local, bucket → bucket (-r: a tree)",
      "  mv <src> <dst>             bucket → bucket (-r: everything under a prefix)",
      "  rm <ss:///bucket/key>…     delete objects (-r: everything under a prefix)",
      "",
      "A storage path is ss:///<bucket>/<key>; anything else is a local path. It runs as the",
      "service role, through the app's own storage driver and metadata. rm -r on a remote store",
      "(S3 off this machine) asks first; --yes skips the question, and without a terminal it is",
      "refused unless --yes.",
    ].join("\n"),
    positionals: [
      { name: "action", help: "ls | cp | mv | rm", required: true },
      { name: "paths", help: "storage (ss:///bucket/key) or local paths", variadic: true },
    ],
    flags: [
      { name: "recursive", alias: "r", type: "boolean", help: "Every key under a prefix" },
      { name: "content-type", type: "string", help: "cp: the uploaded objects' content type" },
      { name: "cache-control", type: "string", help: "cp: the uploaded objects' Cache-Control" },
      { name: "yes", type: "boolean", help: "rm -r on a remote store: confirm without asking" },
    ],
    moduleDir: (ctx) => resolve(ctx.global.cwd ?? "."),
    run: async (ctx) => {
      const name = ctx.positionals[0] ?? "";
      const action = ACTIONS[name];
      if (!action) {
        io.error(`denext storage: unknown action "${name}" (expected ls | cp | mv | rm)`);
        io.exit(1);
        return;
      }
      try {
        await action(ctx, io, resolve(ctx.global.cwd ?? "."));
      } catch (error) {
        io.error(`denext storage ${name}: ${(error as Error)?.message ?? error}`);
        io.exit(1);
      }
    },
  };
}
