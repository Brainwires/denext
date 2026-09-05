// Environment reads that never throw under a narrowed `--allow-env` sandbox (a partial grant
// such as `--allow-env=PORT` makes `Deno.env.get("OTHER")` and `Deno.env.toObject()` throw
// NotCapable). Every hot-path read goes through these so a least-privilege `denext start`
// keeps serving instead of 500ing.

/** `Deno.env.get(name)`, or `undefined` when unset OR not permitted. */
export function envGet(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** `Deno.env.toObject()`, or `{}` when the full environment is not readable. */
export function envAll(): Record<string, string> {
  try {
    return Deno.env.toObject();
  } catch {
    return {};
  }
}
