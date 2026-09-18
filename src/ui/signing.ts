// What a desktop build needs in order to be signed, read from the machine `denext ui` runs on.
// A leaf module, in the shape of `open.ts`: argv arrays only, the platform matrix behind pure
// functions so it is testable without spawning anything, and every failure degrading to "nothing
// found" rather than throwing.
//
// Nothing here reads a secret. `security` is asked WHICH identities exist; the private key never
// leaves the keychain, and the identity string it prints is a name, not a credential.

/** One code-signing identity, as `security find-identity` reports it. */
export interface SigningIdentity {
  /** The certificate's SHA-1 fingerprint, as printed. */
  readonly sha1: string;
  /** The full identity, e.g. `Developer ID Application: A Name (TEAMID)`. */
  readonly name: string;
  /** The Team ID the name ends with, when it carries one. */
  readonly team: string | null;
}

/** The prefix marking an identity that can sign an app for distribution outside the App Store. */
const DEVELOPER_ID = "Developer ID Application:";

/** `  2) <40 hex> "<name>"` — the only line shape carrying an identity. */
const IDENTITY_LINE = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.*)"\s*$/;

/** The Team ID a full identity string ends with. */
const TEAM_ID = /\(([A-Z0-9]{10})\)$/;

/** A program name safe to hand a shell: no metacharacter can appear in it. */
const PLAIN_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The identities in `security find-identity -v -p codesigning` output, filtered to those that can
 * actually sign a distributable app.
 *
 * The filter is not tidying. A developer machine typically also holds an `Apple Development:`
 * certificate; signing with it produces a build that neither distributes nor keeps its TCC grants,
 * so offering it in a picker would be offering the wrong answer confidently.
 *
 * @param output The command's stdout.
 * @returns The Developer ID Application identities, in the order printed.
 */
export function parseIdentities(output: string): SigningIdentity[] {
  const found: SigningIdentity[] = [];
  for (const line of output.split("\n")) {
    const match = IDENTITY_LINE.exec(line);
    // Skips the trailing "N valid identities found", blank lines and anything unrecognised.
    if (!match) continue;
    const [, sha1, name] = match;
    if (!name.startsWith(DEVELOPER_ID)) continue;
    found.push({ sha1: sha1.toUpperCase(), name, team: TEAM_ID.exec(name)?.[1] ?? null });
  }
  return found;
}

/**
 * The command that lists signing identities, or `null` where there is none to run.
 *
 * @param os The platform (defaults to the host).
 * @returns The argv, or `null` off macOS — `security` is a macOS tool.
 */
export function identityCommand(os: typeof Deno.build.os = Deno.build.os): string[] | null {
  return os === "darwin" ? ["security", "find-identity", "-v", "-p", "codesigning"] : null;
}

/**
 * The Developer ID identities this machine holds, best-effort.
 *
 * @param os The platform (defaults to the host).
 * @returns The identities; an empty list off macOS, with no `security` on PATH, without
 *   `--allow-run`, or when the command fails for any other reason.
 */
export async function listSigningIdentities(
  os: typeof Deno.build.os = Deno.build.os,
): Promise<SigningIdentity[]> {
  const argv = identityCommand(os);
  if (argv === null) return [];
  try {
    const out = await new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.code === 0 ? parseIdentities(new TextDecoder().decode(out.stdout)) : [];
  } catch {
    // Spawning a program that is not there THROWS rather than resolving with a failure, so this
    // catch is the ordinary path on a machine without the tool — not an exceptional one.
    return [];
  }
}

/**
 * Whether `cmd` is on PATH.
 *
 * The POSIX branch runs `command -v` through a shell, so the name is checked against a plain
 * character class first: a caller passing anything but a bare program name gets `false` rather
 * than a shell evaluating it. Every call site today passes a literal, and this makes that a
 * property of the function instead of a convention future callers have to remember.
 *
 * @param cmd The program name.
 * @param os The platform (defaults to the host).
 * @returns `true` when a lookup found it; `false` on any failure.
 */
export async function hasCommand(
  cmd: string,
  os: typeof Deno.build.os = Deno.build.os,
): Promise<boolean> {
  if (!PLAIN_NAME.test(cmd)) return false;
  const argv = os === "windows" ? ["cmd", "/c", "where", cmd] : ["sh", "-c", `command -v ${cmd}`];
  try {
    const out = await new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return out.code === 0;
  } catch {
    return false;
  }
}
