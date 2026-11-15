/**
 * The Windows programs the desktop capabilities spawn, by absolute path: what each capability's
 * handler starts and what the package scripts bake as its `--allow-run`, so both name the same
 * file. A bare `powershell.exe` was resolved through `PATH` when the app started and when it
 * spawned, so a `powershell.exe` (or `explorer.exe`, `rundll32.exe`) in a user-writable folder
 * listed before `System32` (a per-user tool's `bin`, say) was the program the grant allowed and the
 * capability ran, fed the capability's script and values. The pty capability's default shells were
 * already absolute.
 *
 * The paths are Windows' own defaults (`%SystemRoot%` = `C:\Windows`), as the pty defaults; a
 * Windows installed elsewhere refuses the spawn (`NotCapable` / not found) rather than run another
 * program.
 *
 * Import-free: read by build code and by the desktop runtime alike.
 *
 * @module
 */

/** Windows PowerShell 5.1 (WinRT types, which `pwsh` does not project). */
export const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** The shell's file manager (open with the default app, reveal in a folder window). */
export const WINDOWS_EXPLORER = "C:\\Windows\\explorer.exe";

/** `rundll32.exe` (`url.dll,FileProtocolHandler`: a URL to its default handler). */
export const WINDOWS_RUNDLL32 = "C:\\Windows\\System32\\rundll32.exe";
