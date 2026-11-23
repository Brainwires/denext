// The real `react-reconciler` (and the packages renderers built on it use) for tests, loaded
// against denext's `react`: each package comes from the npm registry as a tarball pinned by its
// published integrity, and its CommonJS files are evaluated with `require("react")` answering
// denext's `react`. Network-bound (the first call of each package fetches it).

import { assertEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import * as React from "../../src/compat/react.ts";

// deno-lint-ignore no-explicit-any -- the loaded CommonJS modules are untyped.
type Any = any;

// The packages come from the npm registry as tarballs pinned by their published integrity, NOT
// through `npm:` imports: those would add them to the framework's lock and re-resolve the `react`
// peer the lock shares with react-native-web.
const PACKAGES = {
  "react-reconciler": {
    version: "0.31.0",
    integrity:
      "sha512-7Ob7Z+URmesIsIVRjnLoDGwBEG/tVitidU0nMsqX/eeJaLY89RISO/10ERe0MqmzuKUUB1rmY+h1itMbUHg9BQ==",
  },
  "its-fine": {
    version: "2.0.0",
    integrity:
      "sha512-KLViCmWx94zOvpLwSlsx6yOCeMhZYaxrJV87Po5k/FoZzcPSahvK5qJ7fYhS61sZi5ikmh2S3Hz55A2l3U69ng==",
  },
  scheduler: {
    version: "0.25.0",
    integrity:
      "sha512-xFVuu11jh+xcO7JOAGJNOXld8/TcEHK/4CituBUeUb5hqxJLj9YuemAEuvm9gQ/+pgXYfbQuqAkiYu+u7YEsNA==",
  },
} as const;

/** Each package's files, fetched once per process. */
const fetched = new Map<string, Promise<Map<string, string>>>();

/** A package's files (`package/…` paths in the tarball, without that prefix), integrity-checked. */
export function fetchPackage(name: keyof typeof PACKAGES): Promise<Map<string, string>> {
  let files = fetched.get(name);
  if (!files) fetched.set(name, files = download(name));
  return files;
}

/** Download and unpack `name`'s pinned tarball. */
async function download(name: keyof typeof PACKAGES): Promise<Map<string, string>> {
  const { version, integrity } = PACKAGES[name];
  const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tgz = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", tgz));
  assertEquals(`sha512-${encodeBase64(digest)}`, integrity, `${url}: integrity mismatch`);
  const tar = new Uint8Array(
    await new Response(new Blob([tgz]).stream().pipeThrough(new DecompressionStream("gzip")))
      .arrayBuffer(),
  );
  // ustar: a 512-byte header (name 0..100, size in octal at 124, prefix 345..500), then the data
  // padded to 512 bytes.
  const files = new Map<string, string>();
  const text = new TextDecoder();
  const field = (at: number, len: number) =>
    text.decode(tar.subarray(at, at + len)).replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const prefix = field(at + 345, 155);
    const path = (prefix ? `${prefix}/` : "") + field(at, 100);
    const size = parseInt(field(at + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[at + 156]);
    if (type === "0" || type === "\0") {
      files.set(path.replace(/^[^/]+\//, ""), text.decode(tar.subarray(at + 512, at + 512 + size)));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Evaluate one CommonJS file with `require("react")` as denext's `react` (an app's import map
 * does the same for npm code in a build).
 */
export function loadCommonJs(
  source: string | undefined,
  env: "production" | "development",
  deps: Record<string, unknown> = {},
): Any {
  if (source === undefined) throw new Error("missing file in the package");
  const module = { exports: {} as Any };
  const require = (id: string): unknown => {
    if (id === "react") return React;
    if (id in deps) return deps[id];
    throw new Error(`unexpected require("${id}")`);
  };
  new Function("module", "exports", "require", "process", source)(
    module,
    module.exports,
    require,
    { env: { NODE_ENV: env } },
  );
  return module.exports;
}

/**
 * `react-reconciler`'s factory (0.31, React 19) in its production or development build, with its
 * `scheduler`.
 *
 * @param env Which build.
 * @returns `createReconciler`.
 */
export async function loadReactReconciler(env: "production" | "development"): Promise<Any> {
  const reconciler = await fetchPackage("react-reconciler");
  const scheduler = loadCommonJs(
    (await fetchPackage("scheduler")).get(`cjs/scheduler.${env}.js`),
    env,
  );
  return loadCommonJs(reconciler.get(`cjs/react-reconciler.${env}.js`), env, { scheduler });
}
