// Flag parsing shared by the kitchen sink's command-line tools (`window-test.ts`, `drive.ts`).

/** `--name value` / `--name=value` / a bare `--name` (""), and the arguments left over. */
export function parseFlags(args: readonly string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!m) positional.push(args[i]);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    else if (i + 1 < args.length && !args[i + 1].startsWith("--")) flags[m[1]] = args[++i];
    else flags[m[1]] = "";
  }
  return { positional, flags };
}
