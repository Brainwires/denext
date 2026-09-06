// fumadocs-mdx support for the Next-compat bundler.
//
// A fumadocs site's generated `.source/server.ts` imports every doc as
// `../content/docs/x.mdx?collection=docs` and every `meta.json?collection=docs`, expecting the
// `fumadocs-mdx` bundler loader (webpack/vite/bun/Node hook) to compile them with the app's
// `source.config.ts` (frontmatter → `export const frontmatter`, TOC, structured data, the
// configured remark/rehype pipeline). denext's plain MDX loader knows none of that, and the
// fumadocs loader can't be imported into the CLI process (see `fumadocs-mdx-worker.ts`). So:
// when an app has a `source.config.*` AND `fumadocs-mdx` in its node_modules, this plugin
// claims those imports and compiles them through fumadocs' own Node loader hosted in a
// byonm child process — the output is exactly what fumadocs produces under `next build`.

import { dirname, join, toFileUrl } from "@std/path";
import type * as esbuild from "esbuild";
import { minDepAgeArgs } from "./bundle.ts";
import { resolveOnBehalf } from "./esbuild-resolve.ts";

/** Where a fumadocs-mdx app keeps its config; the first that exists wins (fumadocs' order). */
const CONFIG_NAMES = [
  "source.config.ts",
  "source.config.mts",
  "source.config.js",
  "source.config.mjs",
];

/** A fumadocs-mdx installation detected in an app. */
export interface FumadocsMdx {
  /** The app dir (fumadocs resolves `source.config` and `.source/` against it). */
  appDir: string;
  /** `source.config.*` basename. */
  configName: string;
  /** Absolute path of `fumadocs-mdx/node/_loader` in the app's node_modules. */
  loaderPath: string;
}

/**
 * Detect fumadocs-mdx in `appDir`: a `source.config.*` file plus a resolvable
 * `fumadocs-mdx/node/_loader` (via `resolve`, the bundler's SSR-conditions Node resolver).
 * `null` when either is missing (the plain MDX loader applies).
 */
/** Resolves a bare package subpath from a directory (the compat bundler's Node resolver). */
export type NodeResolver = (fromDir: string, spec: string) => Promise<string | null>;

export async function detectFumadocsMdx(
  appDir: string,
  resolve: NodeResolver,
): Promise<FumadocsMdx | null> {
  let configName: string | undefined;
  for (const name of CONFIG_NAMES) {
    try {
      await Deno.stat(join(appDir, name));
      configName = name;
      break;
    } catch { /* try the next */ }
  }
  if (!configName) return null;
  const loaderPath = await resolve(appDir, "fumadocs-mdx/node/_loader");
  return loaderPath ? { appDir, configName, loaderPath } : null;
}

/** Idle time after which a compile host exits (a rebuild respawns it on demand). */
const IDLE_MS = 30_000;

interface Pending {
  resolve: (source: string) => void;
  reject: (err: Error) => void;
}

/** One fumadocs compile host child + the request/response bookkeeping over its stdio. */
class FumadocsHost {
  #child: Deno.ChildProcess | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #stderr = "";

  constructor(readonly install: FumadocsMdx) {}

  /** Compile the module at `fileUrl` (a `file://` URL carrying the fumadocs query). */
  request(fileUrl: string): Promise<string> {
    this.#ensureChild();
    const id = this.#nextId++;
    return new Promise<string>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#writer!.write(new TextEncoder().encode(JSON.stringify({ id, url: fileUrl }) + "\n"))
        .catch((e) => this.#fail(id, e));
      this.#touch();
    });
  }

  /** Stop the child (pending requests reject). */
  dispose(): void {
    clearTimeout(this.#idle);
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    this.#writer?.close().catch(() => {});
    this.#writer = null;
    try {
      child.kill();
    } catch { /* already gone */ }
    for (const [id] of this.#pending) this.#fail(id, new Error("fumadocs-mdx host disposed"));
  }

  #ensureChild(): void {
    if (this.#child) return;
    const { appDir, configName, loaderPath } = this.install;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--node-modules-dir=manual",
        "--no-config",
        "--no-lock",
        ...minDepAgeArgs(),
        new URL("./fumadocs-mdx-worker.ts", import.meta.url).href,
        appDir,
        toFileUrl(loaderPath).href,
        configName,
      ],
      cwd: appDir,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    child.unref();
    this.#child = child;
    this.#writer = child.stdin.getWriter();
    this.#stderr = "";
    void this.#readLines(child.stdout, (line) => this.#onLine(line));
    void this.#readLines(child.stderr, (line) => {
      this.#stderr = (this.#stderr + line + "\n").slice(-4000);
    });
    child.status.then(() => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#writer = null;
      const why = this.#stderr.trim() || "exited";
      for (const [id] of this.#pending) {
        this.#fail(id, new Error(`fumadocs-mdx compile host ${why}`));
      }
    });
  }

  async #readLines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    } catch { /* stream closed with the child */ }
    if (buf.trim()) onLine(buf);
  }

  #onLine(line: string): void {
    let msg: { id: number; source?: string; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours (a stray console.log from a config plugin)
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (typeof msg.source === "string") p.resolve(msg.source);
    else p.reject(new Error(msg.error ?? "fumadocs-mdx returned no source"));
    this.#touch();
  }

  #fail(id: number, err: unknown): void {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    p.reject(err instanceof Error ? err : new Error(String(err)));
  }

  #touch(): void {
    clearTimeout(this.#idle);
    if (this.#pending.size > 0) return;
    const timer = setTimeout(() => this.dispose(), IDLE_MS);
    this.#idle = timer;
    Deno.unrefTimer(timer);
  }
}

const hosts = new Map<string, FumadocsHost>();

/** The (lazily spawned, shared per app dir) compile host for `install`. */
function fumadocsHost(install: FumadocsMdx): FumadocsHost {
  let host = hosts.get(install.appDir);
  if (!host) {
    host = new FumadocsHost(install);
    hosts.set(install.appDir, host);
  }
  return host;
}

/** Stop every compile host (build end, dev-server teardown, tests). */
export function disposeFumadocsHosts(): void {
  for (const host of hosts.values()) host.dispose();
  hosts.clear();
}

/** Import paths fumadocs' loaders own: MDX (with or without a query) and queried meta files. */
const QUERIED = /\.(mdx?|json|ya?ml)\?/;
const LOADABLE = /\.(mdx?|json|ya?ml)$/;

/**
 * esbuild plugin: compile `.mdx`/`.md` imports and `*.json?collection=…`/`*.yaml?…` meta
 * imports through the app's fumadocs-mdx (see the module comment). Register it BEFORE the
 * plain MDX plugin: esbuild takes the first `onLoad` result, so fumadocs wins for MDX while
 * unqueried JSON/YAML falls through to the default loaders untouched.
 */
export function fumadocsMdxPlugin(install: FumadocsMdx): esbuild.Plugin {
  return {
    name: "denext-fumadocs-mdx",
    setup(build) {
      // `./x.mdx?collection=docs` can't be resolved by esbuild's default resolver (the query
      // is part of the path). Resolve the file, keep the query as the module's `suffix`.
      build.onResolve({ filter: QUERIED }, async (args) => {
        const qIdx = args.path.indexOf("?");
        const resolved = await resolveOnBehalf(build, args, args.path.slice(0, qIdx));
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        return {
          path: resolved.path,
          namespace: resolved.namespace,
          suffix: args.path.slice(qIdx),
        };
      });
      build.onLoad({ filter: LOADABLE, namespace: "file" }, async (args) => {
        const isMdx = /\.mdx?$/.test(args.path);
        if (!isMdx && !/[?&]collection=/.test(args.suffix)) return undefined;
        const url = toFileUrl(args.path).href + args.suffix;
        return {
          contents: await fumadocsHost(install).request(url),
          loader: "js",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}
