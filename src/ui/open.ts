// Open a URL in the user's default browser. The first browser-open helper in denext; kept as a
// leaf module so `denext ui` is the only thing that pays for it.
//
// Array args only — the URL is never passed through a shell, so a crafted project path or port
// can never become a command. Every failure mode (no opener installed, a sandbox with no
// process permission, Windows quirks) degrades to `false`, and the caller prints the URL.

/**
 * The opener command for this platform, as `[program, ...args]` with `url` already appended.
 * Pure, so the platform matrix is unit-testable without spawning anything.
 *
 * @param url The URL to open.
 * @param os The platform (defaults to the host).
 * @returns The argv, or `null` on a platform with no known opener.
 */
export function openCommand(
  url: string,
  os: typeof Deno.build.os = Deno.build.os,
): string[] | null {
  if (os === "darwin") return ["open", url];
  if (os === "windows") return ["cmd", "/c", "start", "", url];
  if (os === "android") return null;
  return ["xdg-open", url]; // linux + the BSDs: freedesktop's opener
}

/**
 * Open `url` in the default browser, best-effort.
 *
 * @param url The URL to open.
 * @returns `true` when the opener exited cleanly; `false` when it could not be run (the caller
 *   should print the URL instead).
 */
export async function openBrowser(url: string): Promise<boolean> {
  const argv = openCommand(url);
  if (!argv) return false;
  try {
    const { success } = await new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false; // no opener on PATH, or no --allow-run
  }
}
