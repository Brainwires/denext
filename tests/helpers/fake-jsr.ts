// A JSR registry on loopback for resolution tests: Deno reads it through `JSR_URL`. It serves
// what Deno fetches for a package (`meta.json`, `<version>_meta.json` with each file's checksum,
// the files) for the packages and versions it is given, every version published long ago (so no
// dependency-age hold applies unless a test sets one longer than that).

/** A package's versions: version → its `mod.ts` source. */
export type FakeJsrPackages = Record<string, Record<string, string>>;

/** A running registry. */
export interface FakeJsr {
  /** The `JSR_URL` (with a trailing slash). */
  readonly url: string;
  /** The lockfile integrity of `pkg@version` (the SHA-256 of its version metadata). */
  integrity(pkg: string, version: string): string;
  /** Stop serving. */
  close(): Promise<void>;
}

/** When every version was published. */
const PUBLISHED = "2024-01-01T00:00:00Z";

/** Hex SHA-256. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Serve `packages` (`@scope/name` → versions) as a JSR registry.
 *
 * @param packages The packages.
 * @returns The registry.
 */
export async function startFakeJsr(packages: FakeJsrPackages): Promise<FakeJsr> {
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const integrities = new Map<string, string>();
  for (const [pkg, versions] of Object.entries(packages)) {
    const [scope, name] = pkg.slice(1).split("/");
    const sorted = Object.keys(versions).sort();
    files.set(
      `/${pkg}/meta.json`,
      enc.encode(JSON.stringify({
        scope,
        name,
        latest: sorted.at(-1),
        versions: Object.fromEntries(sorted.map((v) => [v, { createdAt: PUBLISHED }])),
      })),
    );
    for (const [version, source] of Object.entries(versions)) {
      const mod = enc.encode(source);
      files.set(`/${pkg}/${version}/mod.ts`, mod);
      const meta = enc.encode(JSON.stringify({
        manifest: { "/mod.ts": { size: mod.length, checksum: `sha256-${await sha256(mod)}` } },
        exports: { ".": "./mod.ts" },
      }));
      files.set(`/${pkg}/${version}_meta.json`, meta);
      integrities.set(`${pkg}@${version}`, await sha256(meta));
    }
  }
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const body = files.get(new URL(req.url).pathname);
    return body ? new Response(body) : new Response("not found", { status: 404 });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}/`,
    integrity: (pkg, version) => {
      const value = integrities.get(`${pkg}@${version}`);
      if (!value) throw new Error(`the registry serves no ${pkg}@${version}`);
      return value;
    },
    close: () => server.shutdown(),
  };
}
