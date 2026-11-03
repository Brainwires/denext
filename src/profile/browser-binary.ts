// The Chrome for Testing build that astral launches, fetched through denext's download deadlines
// and retries (src/build/verified-download.ts) rather than astral's own download: astral reads the
// whole archive (about 150 MB) through one `fetch` with no deadline and no retry, so a connection
// that stalls mid-body holds the launch until the server drops it, minutes later, and then fails
// it ("error reading a body from connection"). Here a stalled or broken connection is given up on
// after the idle deadline and retried on a new one. The result goes into astral's own cache layout
// (`<cache>/<version>/…`, recorded in `<cache>/cache.json`), so astral finds it as its own, and a
// browser astral downloaded before is used as it is.

import { getDefaultCachePath, SUPPORTED_VERSIONS } from "@astral/astral";
import { join } from "@std/path";
import { extractArchive } from "../build/safe-extract.ts";
import {
  type DownloadDeadlines,
  fetchWithConnectDeadline,
  readJsonFile,
  responseBody,
  streamHashed,
  withDownloadRetries,
} from "../build/verified-download.ts";

/** Where Chrome for Testing's archives are published. */
const CHROME_FOR_TESTING = "https://storage.googleapis.com/chrome-for-testing-public";
/** The most bytes a browser archive may hold. */
const MAX_ARCHIVE_BYTES = 1024 ** 3;

/** Seams for {@linkcode ensureBrowserBinary}; each defaults to this process. */
export interface BrowserBinaryOptions {
  /** astral's cache directory (default: astral's own). */
  readonly cache?: string;
  /** The archive host (default: Chrome for Testing's). */
  readonly baseUrl?: string;
  /** `fetch`. */
  readonly fetch?: typeof fetch;
  /** The download's deadlines (default: `DENEXT_DOWNLOAD_*`). */
  readonly deadlines?: DownloadDeadlines;
  /** Told about each retry. */
  readonly log?: (line: string) => void;
  /** The host (default: `Deno.build`). */
  readonly host?: { readonly os: string; readonly arch: string };
  /** Reads an environment variable. */
  readonly env?: (name: string) => string | undefined;
}

/**
 * Chrome for Testing's platform name for a host, and the browser executable inside the archive's
 * folder (astral's own layout); null where it publishes no build.
 *
 * @param host The OS and architecture.
 * @returns The platform and the executable's path relative to the version folder.
 */
export function chromePlatform(
  host: { readonly os: string; readonly arch: string },
): { platform: string; executable: string } | null {
  const mac = (platform: string) => ({
    platform,
    executable: join(
      `chrome-${platform}`,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ),
  });
  if (host.os === "darwin") return mac(host.arch === "aarch64" ? "mac-arm64" : "mac-x64");
  if (host.os === "windows") {
    return { platform: "win64", executable: join("chrome-win64", "chrome.exe") };
  }
  if (host.os === "linux" && host.arch === "x86_64") {
    return { platform: "linux64", executable: join("chrome-linux64", "chrome") };
  }
  return null;
}

/** Whether `path` is an existing file. */
async function isFile(path: string): Promise<boolean> {
  return await Deno.stat(path).then((s) => s.isFile, () => false);
}

/**
 * The Chrome astral launches, downloaded into astral's cache when it is not there yet (with the
 * download deadlines and retries of denext's other downloads); its executable's path, to pass to
 * astral's `launch({ path })`. Null when astral should find the browser itself: `ASTRAL_BIN_PATH`
 * names one, or Chrome for Testing has no build for this host.
 *
 * Concurrent callers (test files run in parallel) download once: the first holds a lock on
 * `<cache>/.denext-browser.lock` until the browser is in place.
 *
 * @param options Seams (tests).
 * @returns The executable, or null.
 */
export async function ensureBrowserBinary(
  options: BrowserBinaryOptions = {},
): Promise<string | null> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  if (env("ASTRAL_BIN_PATH")) return null;
  const target = chromePlatform(options.host ?? Deno.build);
  if (target === null) return null;
  const cache = options.cache ?? getDefaultCachePath();
  const version = SUPPORTED_VERSIONS.chrome;
  const cached = async () => {
    const folder = (await readJsonFile<Record<string, string>>(join(cache, "cache.json")))
      ?.[version];
    const executable = folder ? join(folder, target.executable) : null;
    return executable && await isFile(executable) ? executable : null;
  };
  const found = await cached();
  if (found) return found;
  await Deno.mkdir(cache, { recursive: true });
  using lock = await Deno.open(join(cache, ".denext-browser.lock"), {
    write: true,
    create: true,
  });
  await lock.lock(true);
  // Another process may have put it in place while this one waited.
  const meanwhile = await cached();
  if (meanwhile) return meanwhile;
  await installChrome(cache, version, target.platform, options);
  return join(cache, version, target.executable);
}

/** Download, extract and record the Chrome `version` for `platform` in astral's cache. */
async function installChrome(
  cache: string,
  version: string,
  platform: string,
  options: BrowserBinaryOptions,
): Promise<void> {
  const url = `${options.baseUrl ?? CHROME_FOR_TESTING}/${version}/${platform}/` +
    `chrome-${platform}.zip`;
  const archive = join(cache, `.denext-chrome-${version}-${Deno.pid}.zip`);
  const staging = join(cache, `.denext-chrome-${version}-${Deno.pid}`);
  const folder = join(cache, version);
  const what = `Chrome for Testing ${version}`;
  const fail = (detail: string, cause?: unknown) =>
    new Error(`denext: could not download ${what} from ${url}${detail}`, { cause });
  try {
    await withDownloadRetries(
      what,
      async ({ fetch: fetchOnce, deadlines }) => {
        try {
          const res = await fetchWithConnectDeadline(
            fetchOnce,
            url,
            undefined,
            deadlines.connectMs,
          );
          const body = await responseBody(res, url, (status) => fail("", status));
          return await streamHashed(
            body,
            archive,
            MAX_ARCHIVE_BYTES,
            {
              tooLarge: () => fail(`: larger than ${MAX_ARCHIVE_BYTES} bytes`),
              interrupted: (bytes, err) => fail(` (interrupted after ${bytes} bytes)`, err),
            },
            undefined,
            deadlines.idleMs,
          );
        } catch (err) {
          await Deno.remove(archive).catch(() => {});
          throw err;
        }
      },
      options.fetch ?? fetch,
      (report) => fail(report),
      { log: options.log ?? ((line) => console.error(line)), deadlines: options.deadlines },
    );
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    await extractArchive(archive, "zip", staging);
    // A folder without a cache.json entry is an extraction that never finished.
    await Deno.remove(folder, { recursive: true }).catch(() => {});
    await Deno.rename(staging, folder);
    const configPath = join(cache, "cache.json");
    const config = await readJsonFile<Record<string, string>>(configPath) ?? {};
    const next = `${configPath}.${Deno.pid}.tmp`;
    await Deno.writeTextFile(next, JSON.stringify({ ...config, [version]: folder }));
    await Deno.rename(next, configPath);
  } finally {
    await Deno.remove(archive).catch(() => {});
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}
