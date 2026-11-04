// Scripts for Windows PowerShell 5.1 (`powershell.exe`) that load its own modules, whatever
// module path it inherited.
//
// Started by a process that PowerShell 7 launched (an app or the CLI run from a `pwsh`
// terminal), `powershell.exe` inherits 7's `PSModulePath`. 5.1 then finds 7's copies of
// `Microsoft.PowerShell.Utility` / `Management` / `Security` first, cannot load them, and every
// cmdlet they hold (`Add-Type`, `New-Object`, `ConvertFrom-Json`, …) fails with
// `CouldNotAutoloadMatchingModule`. Pointing the module path at `$PSHOME\Modules` inside the
// script fixes it without touching the child's environment (a least-privilege app may not hold
// the env permission to rebuild it).

/** The statement that points `PSModulePath` at Windows PowerShell's own module directory. */
export const OWN_MODULE_PATH = '$env:PSModulePath = "$PSHOME\\Modules"';

/**
 * `script`, run after {@link OWN_MODULE_PATH}, so its cmdlets autoload from Windows PowerShell's
 * own modules.
 *
 * @param script The PowerShell script (one line or several).
 * @returns The script with the module-path reset first.
 */
export function withOwnModules(script: string): string {
  return `${OWN_MODULE_PATH}; ${script}`;
}
