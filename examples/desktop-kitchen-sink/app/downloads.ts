// What the download checks (app/checks.ts), the app's own server (desktop.ts) and the window test's
// download server (e2e/window-test.ts) agree on: the paths, the file names and their contents.

/** The runner's server: a small file `downloadToFile` saves whole. */
export const DOWNLOAD_PATH = "/kitchen-download.txt";
/** Its body. */
export const DOWNLOAD_TEXT = "downloaded by the kitchen sink window test\n";

/**
 * The runner's server: a body that trickles out ({@link SLOW_CHUNK} bytes every
 * {@link SLOW_INTERVAL_MS}, {@link SLOW_SIZE} in all), so a download of it is still running when
 * the page aborts it.
 */
export const SLOW_PATH = "/kitchen-slow.bin";
export const SLOW_CHUNK = 16 * 1024;
export const SLOW_INTERVAL_MS = 100;
export const SLOW_SIZE = 8 * 1024 * 1024;

/** The `<a download>` blob export: the name the page proposes and the bytes. */
export const BLOB_NAME = "kitchen-blob.txt";
export const BLOB_TEXT = "a blob the kitchen sink exported with <a download>\n";

/** The app origin's `Content-Disposition: attachment` response (served by desktop.ts). */
export const ATTACHMENT_PATH = "/_kitchen/attachment.txt";
export const ATTACHMENT_NAME = "kitchen-attachment.txt";
export const ATTACHMENT_TEXT = "an attachment the kitchen sink's own origin served\n";

/** The attachment response {@link ATTACHMENT_PATH} answers with. */
export function attachmentResponse(): Response {
  return new Response(ATTACHMENT_TEXT, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${ATTACHMENT_NAME}"`,
      "cache-control": "no-store",
    },
  });
}

/** What the runner offers the download checks (`app/checks.ts`). */
export interface RunnerDownloads {
  /**
   * The base URL `downloadToFile` fetches from: a server on this machine's private network address
   * (the fs capability refuses loopback hosts), or `null` with {@link RunnerDownloads.skip}.
   */
  readonly base: string | null;
  /** Why there is no {@link RunnerDownloads.base}. */
  readonly skip: string | null;
  /**
   * How the runner answers a page download's save dialog (`xdotool`, `osascript`, `sendkeys`), or
   * `null` with {@link RunnerDownloads.dialogSkip}.
   */
  readonly dialogs: string | null;
  /** Why the runner can't answer a save dialog here. */
  readonly dialogSkip: string | null;
}
