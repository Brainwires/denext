// Project-relative paths as the mobile tooling reports and writes them: always `/`-separated,
// whatever the host OS. A path written into a native file (an Xcode project, a Gradle file, an
// Info.plist or manifest reference) or listed in a report must not carry Windows' `\` — a
// backslash in a pbxproj entry breaks the project when it is next opened on a Mac, and the
// reports are compared against the `/` paths the installers name.

import { relative, SEPARATOR } from "@std/path";

/**
 * `path` with the host separator replaced by `/` (a no-op on macOS / Linux, where `\` is a
 * legal file-name character and is left alone).
 *
 * @param path A host path.
 * @returns The same path, `/`-separated.
 */
export function toPosixPath(path: string): string {
  return SEPARATOR === "\\" ? path.replaceAll("\\", "/") : path;
}

/**
 * `relative(from, to)`, `/`-separated on every OS.
 *
 * @param from The base folder.
 * @param to The path to express relative to it.
 * @returns The relative path, `/`-separated.
 */
export function posixRelative(from: string, to: string): string {
  return toPosixPath(relative(from, to));
}
